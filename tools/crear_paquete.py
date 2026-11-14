#!/usr/bin/env python3
"""
Crea el paquete de Dariopedia a partir del volcado oficial de la Wikipedia.

Solo texto: sin imágenes, tablas, fichas ni referencias. Dos modos:
  resumen   (por defecto)  la introducción de cada artículo, recortada
  completo                 todo el texto, sin secciones de relleno (Referencias, etc.)

Uso:
  python3 crear_paquete.py                      # descarga eswiki y crea ./paquete/
  python3 crear_paquete.py --modo completo
  python3 crear_paquete.py --volcado eswiki-latest-pages-articles.xml.bz2 --salida paquete
  python3 crear_paquete.py --idioma en

Salida: paquete/dariopedia-<idioma>-<modo>-0001.ndjson.gz, 0002, ... y manifest.json.
Impórtalos en la app (Descargas → Importar). Solo usa la biblioteca estándar de Python.
"""
import argparse, bz2, gzip, html, json, multiprocessing as mp, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET

SECCIONES_FUERA = {
    'es': {'referencias', 'enlaces externos', 'véase también', 'notas', 'bibliografía', 'notas y referencias',
           'notas al pie', 'fuentes', 'otros proyectos', 'lecturas adicionales', 'galería', 'galería de imágenes'},
    'en': {'references', 'external links', 'see also', 'notes', 'bibliography', 'further reading', 'sources', 'gallery'},
}
REDIR = re.compile(r'^\s*#\s*(redirect|redirecci[oó]n|redirecionamento|redirection|weiterleitung|rinvia)', re.I)
DESAMBIG = re.compile(r'\{\{\s*(desambiguaci[oó]n|disambiguation|disambig)\b', re.I)

RE_COMENT = re.compile(r'<!--.*?-->', re.S)
RE_REF = re.compile(r'<ref\b[^>/]*?>.*?</ref\s*>|<ref\b[^>]*?/>', re.S | re.I)
RE_BLOQUES = re.compile(r'<(gallery|timeline|imagemap|math|chem|score|syntaxhighlight|source|pre|code|references|noinclude|poem|nowiki)\b.*?</\1\s*>', re.S | re.I)
RE_TABLA = re.compile(r'\{\|(?:(?!\{\|).)*?\|\}', re.S)
RE_PLANT = re.compile(r'\{\{[^{}]*\}\}')
RE_LANG = re.compile(r'\{\{\s*(?:lang|nowrap|esc|texto|small|smaller|nobr)(?:-\w+)?\s*\|(?:[^{}|=]*\|)?([^{}|]*)\}\}', re.I)
RE_ARCH = re.compile(r'\[\[\s*(?:archivo|file|imagen|image|categor[ií]a|category)\s*:[^\[\]]*(?:\[\[[^\[\]]*\]\][^\[\]]*)*\]\]', re.I)
RE_ENL = re.compile(r'\[\[(?:[^\[\]|]*\|)?([^\[\]]*)\]\]')
RE_EXT = re.compile(r'\[(?:https?:)?//\S+\s*([^\]]*)\]')
RE_HTML = re.compile(r'</?[a-zA-Z][^>]*>')
RE_NEGR = re.compile(r"'{2,5}")
RE_LISTA = re.compile(r'^[*#:;]+\s*', re.M)
RE_TITULO = re.compile(r'^(={2,6})\s*(.*?)\s*\1\s*$', re.M)
RE_ESPACIOS = re.compile(r'[ \t\xa0]+')
RE_ARCHLINEA = re.compile(r'^(archivo|file|imagen|image|categor[ií]a|category)\s*:', re.I)
RE_MAGIC = re.compile(r'__[A-Z]+__|\{\{\{[^{}]*\}\}\}')


def quitar_plantillas(t):
    """Elimina {{...}} con anidamiento (recuento de llaves)."""
    out, prof, i, n = [], 0, 0, len(t)
    while i < n:
        a, b = t.find('{{', i), t.find('}}', i)
        if prof == 0:
            if a < 0: out.append(t[i:]); break
            out.append(t[i:a]); prof = 1; i = a + 2
        else:
            if b < 0: break  # plantilla sin cerrar: se descarta el resto
            if 0 <= a < b: prof += 1; i = a + 2
            else: prof -= 1; i = b + 2
    return ''.join(out)


def limpiar(wt):
    """Wikitexto -> texto plano. Rápido y aproximado (suficiente para leer)."""
    t = RE_COMENT.sub('', wt)
    t = RE_REF.sub('', t)
    t = RE_BLOQUES.sub('', t)
    for _ in range(3):
        n = RE_TABLA.sub('', t)
        if n == t: break
        t = n
    t = RE_MAGIC.sub('', t)
    t = RE_LANG.sub(r'\1', t)
    t = quitar_plantillas(t)
    t = RE_ARCH.sub('', t)
    t = RE_ENL.sub(r'\1', t)
    t = RE_EXT.sub(r'\1', t)
    t = RE_HTML.sub('', t)
    t = RE_NEGR.sub('', t)
    t = t.replace('[[', '').replace(']]', '')
    t = html.unescape(t)
    return t


def a_parrafos(t, titulos=False):
    t = RE_LISTA.sub('', t) if not titulos else RE_LISTA.sub('', t)
    out = []
    for p in re.split(r'\n\s*\n|\n', t):
        p = RE_ESPACIOS.sub(' ', p).strip()
        if len(p) < 2 or p.startswith(('{|', '|', '!', '|}')) or re.fullmatch(r'[\W_]+', p) or RE_ARCHLINEA.match(p): continue
        out.append(p)
    return out


def recortar(texto, maximo):
    if len(texto) <= maximo: return texto
    corte = texto[:maximo]
    m = max(corte.rfind('. '), corte.rfind('.\n'))
    return corte[:m + 1] if m > maximo * 0.5 else corte.rsplit(' ', 1)[0] + '…'


def procesar(args):
    titulo, wt, modo, maximo, minimo, lang, desamb = args
    if REDIR.match(wt): return None
    if not desamb and DESAMBIG.search(wt[:3000]): return None
    if modo == 'resumen':
        i = re.search(r'^==', wt, re.M)
        lead = wt[:i.start()] if i else wt
        pars = a_parrafos(limpiar(lead))
        texto = recortar('\n\n'.join(pars), maximo)
    else:
        fuera = SECCIONES_FUERA.get(lang, SECCIONES_FUERA['es'])
        t = limpiar(wt)
        partes = RE_TITULO.split(t)  # [intro, marcas, titulo, cuerpo, marcas, titulo, cuerpo...]
        bloques = a_parrafos(partes[0])
        saltar_nivel = None
        for k in range(1, len(partes), 3):
            nivel, nombre, cuerpo = len(partes[k]), partes[k + 1].strip(), partes[k + 2]
            if saltar_nivel and nivel > saltar_nivel: continue
            saltar_nivel = None
            if nombre.lower() in fuera:
                saltar_nivel = nivel; continue
            pars = a_parrafos(cuerpo)
            if pars: bloques.append('#' * nivel + ' ' + nombre); bloques += pars
        texto = '\n\n'.join(bloques)
    if len(texto) < minimo: return None
    return {'title': titulo, 'text': texto}


def paginas(f, modo, maximo, minimo, lang, desamb):
    titulo, ns, wt, vacio = None, None, None, False
    for ev, el in ET.iterparse(f, events=('end',)):
        tag = el.tag.rsplit('}', 1)[-1]
        if tag == 'title': titulo = el.text
        elif tag == 'ns': ns = el.text
        elif tag == 'text': wt = el.text or ''
        elif tag == 'page':
            if ns == '0' and titulo and wt: yield (titulo, wt, modo, maximo, minimo, lang, desamb)
            titulo = ns = wt = None
            el.clear()


def abrir(origen):
    if os.path.exists(origen):
        return bz2.open(origen, 'rb')
    resp = urllib.request.urlopen(urllib.request.Request(origen, headers={'User-Agent': 'Dariopedia-paquete/1.0'}))
    return bz2.open(resp, 'rb')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--idioma', default='es')
    ap.add_argument('--modo', choices=['resumen', 'completo'], default='resumen')
    ap.add_argument('--volcado', help='archivo .xml.bz2 local o URL (por defecto, el último de Wikimedia)')
    ap.add_argument('--salida', default='paquete')
    ap.add_argument('--max-caracteres', type=int, default=1200, help='tamaño máximo del resumen')
    ap.add_argument('--min-caracteres', type=int, default=80, help='descarta artículos más cortos')
    ap.add_argument('--por-archivo', type=int, default=100000, help='artículos por archivo')
    ap.add_argument('--limite', type=int, default=0, help='parar tras N artículos (pruebas)')
    ap.add_argument('--con-desambiguaciones', action='store_true')
    ap.add_argument('--procesos', type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()

    origen = a.volcado or f'https://dumps.wikimedia.org/{a.idioma}wiki/latest/{a.idioma}wiki-latest-pages-articles.xml.bz2'
    os.makedirs(a.salida, exist_ok=True)
    print(f'Origen: {origen}\nModo: {a.modo} · procesos: {a.procesos}', file=sys.stderr)

    n_arch, n_art, en_arch, bytes_txt, f = 0, 0, 0, 0, None
    t0 = time.time(); nombres = []

    def nuevo():
        nonlocal n_arch, f, en_arch
        if f: f.close()
        n_arch += 1; en_arch = 0
        nombre = f'dariopedia-{a.idioma}-{a.modo}-{n_arch:04d}.ndjson.gz'
        nombres.append(nombre)
        f = gzip.open(os.path.join(a.salida, nombre), 'wt', encoding='utf-8', compresslevel=9)

    nuevo()
    src = abrir(origen)
    gen = paginas(src, a.modo, a.max_caracteres, a.min_caracteres, a.idioma, a.con_desambiguaciones)
    try:
        with mp.Pool(a.procesos) as pool:
            for r in pool.imap(procesar, gen, chunksize=100):
                if r is None: continue
                if en_arch >= a.por_archivo: nuevo()
                line = json.dumps({'lang': a.idioma, **r}, ensure_ascii=False)
                f.write(line + '\n'); en_arch += 1; n_art += 1; bytes_txt += len(line)
                if n_art % 5000 == 0:
                    print(f'\r{n_art:,} artículos · {bytes_txt/1e6:,.0f} MB de texto · {time.time()-t0:,.0f} s', end='', file=sys.stderr)
                if a.limite and n_art >= a.limite: break
    except (EOFError, ET.ParseError, OSError) as e:
        print(f'\nAviso: el volcado termina antes de tiempo ({e}); se guarda lo procesado.', file=sys.stderr)
    f.close()
    tam = sum(os.path.getsize(os.path.join(a.salida, n)) for n in nombres)
    json.dump({'idioma': a.idioma, 'modo': a.modo, 'articulos': n_art, 'archivos': nombres, 'bytes': tam,
               'origen': origen}, open(os.path.join(a.salida, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    print(f'\nListo: {n_art:,} artículos en {len(nombres)} archivo(s), {tam/1e6:,.1f} MB comprimidos '
          f'({time.time()-t0:,.0f} s).', file=sys.stderr)


if __name__ == '__main__':
    main()
