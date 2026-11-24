#!/usr/bin/env python3
"""
Convierte el paquete de crear_paquete.py en el formato que usa la app: ./datos/

  datos/indice.json            lista de bloques: [primera clave, archivo, nº de entradas, bytes]
  datos/b0001.gz ... bNNNN.gz  bloques de ~1,2 MB (sin comprimir) ordenados por título

Cada bloque es un gzip de líneas JSON:  ["Título", "texto"]   o   ["Alias", 0, "Título real"]
Como están ordenados, la app localiza un artículo con una búsqueda binaria sobre el índice
y solo lee un bloque pequeño. Descargarlo es bajar archivos sueltos: se puede reanudar y
reintentar archivo a archivo, y no hay base de datos que escribir en el móvil.

Uso:  python3 tools/indexar.py --entrada paquete --salida datos
"""
import argparse, glob, gzip, hashlib, json, os, sys, unicodedata


def norm(s):
    s = unicodedata.normalize('NFD', s.lower().replace('_', ' '))
    return ''.join(c for c in s if not 0x300 <= ord(c) <= 0x36f).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--entrada', default='paquete')
    ap.add_argument('--salida', default='datos')
    ap.add_argument('--bytes-bloque', type=int, default=1_200_000)
    a = ap.parse_args()

    entradas = []   # (clave, título, texto | None, destino | None)
    arts = alias = 0
    for f in sorted(glob.glob(os.path.join(a.entrada, '*.ndjson.gz'))):
        es_alias = '-redirecciones-' in f
        with gzip.open(f, 'rt', encoding='utf-8') as fh:
            for linea in fh:
                o = json.loads(linea)
                t = o['title']
                if es_alias:
                    entradas.append((norm(t), t, None, o['to'])); alias += 1
                else:
                    entradas.append((norm(t), t, o['text'], None)); arts += 1
        print(f'{f}: {len(entradas):,} entradas', file=sys.stderr)

    print('Ordenando…', file=sys.stderr)
    entradas.sort(key=lambda e: (e[0], e[1]))
    # Un alias no puede tapar a un artículo real con el mismo título exacto.
    os.makedirs(a.salida, exist_ok=True)
    for viejo in glob.glob(os.path.join(a.salida, 'b*.gz')): os.remove(viejo)

    indice, buf, tam, n = [], [], 0, 0
    def volcar():
        nonlocal buf, tam, n
        if not buf: return
        n += 1
        nombre = f'b{n:04d}.gz'
        datos = ('\n'.join(buf)).encode('utf-8')
        comp = gzip.compress(datos, 9, mtime=0)
        with open(os.path.join(a.salida, nombre), 'wb') as fh: fh.write(comp)
        indice.append([primera, nombre, len(buf), len(comp), hashlib.sha1(comp).hexdigest()[:10]])
        buf, tam = [], 0

    primera = ''
    for clave, t, texto, destino in entradas:
        linea = json.dumps([t, texto] if destino is None else [t, 0, destino], ensure_ascii=False, separators=(',', ':'))
        if not buf: primera = clave
        buf.append(linea); tam += len(linea)
        if tam >= a.bytes_bloque:
            # no cortar entre títulos con la misma clave: la búsqueda binaria asume claves crecientes por bloque
            volcar()
    volcar()

    total = sum(i[3] for i in indice)
    meta = {'version': 1, 'idioma': 'es', 'articulos': arts, 'alias': alias, 'bytes': total, 'bloques': indice}
    with open(os.path.join(a.salida, 'indice.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'Listo: {arts:,} artículos + {alias:,} alias en {len(indice)} bloques, {total/1e6:,.1f} MB.', file=sys.stderr)


if __name__ == '__main__':
    main()
