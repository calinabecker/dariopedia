# Dariopedia

La Wikipedia, instalable como app (PWA) y usable **sin conexión**.

## Cómo usarla
1. Publicá la carpeta `dariopedia/` en cualquier hosting estático con HTTPS (GitHub Pages, Netlify…),
   o probala localmente: `cd dariopedia && python3 -m http.server 8080` → http://localhost:8080
2. Abrila en el navegador y elegí **Instalar app** / **Agregar a pantalla de inicio**.
3. Bajá contenido para tenerlo offline:
   - Todo artículo que abrís se guarda automáticamente (con imágenes).
   - **Descargas**: artículos destacados, una categoría completa, al azar, una lista de títulos
     o *toda* la Wikipedia (reanudable, pero muy lento por la API).
   - **Todo de una vez**: bajá el volcado oficial HTML de Wikimedia
     (`https://dumps.wikimedia.org/other/enterprise_html/runs/` → `eswiki-NS0-…-ENTERPRISE-HTML.json.tar.gz`)
     e importalo desde *Descargas → Importar*. Se procesa en streaming y se guarda comprimido.

Sin conexión funcionan la lectura, la búsqueda por título, el artículo al azar y la lectura en voz alta
con las voces del dispositivo.

## Voz
- **Voz del dispositivo**: Web Speech API, 100 % offline si el sistema tiene voces instaladas.
- **Voz clonada**: en *Ajustes → Voz* subís un audio de muestra y se crea una voz con ElevenLabs
  (necesita cuenta y clave de API). Generar audio nuevo requiere internet; todo lo ya escuchado queda
  guardado y se reproduce offline. Usá solo voces propias o con permiso de la persona.
- Seleccioná cualquier texto de un artículo y tocá **🔊 Leer selección**.

Contenido de Wikipedia bajo licencia CC BY-SA 4.0.
