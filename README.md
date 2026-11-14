# Dariopedia

La Wikipedia, instalable como app (PWA) y usable **sin conexión**.

## Cómo usarla
1. Publica este repositorio en cualquier hosting estático con HTTPS (GitHub Pages, Netlify…),
   o pruébala localmente: `python3 -m http.server 8080` → http://localhost:8080
2. Ábrela en el navegador y elige **Instalar aplicación** / **Añadir a la pantalla de inicio**.
3. Descarga contenido para tenerlo sin conexión:
   - Todo artículo que abres se guarda automáticamente (con imágenes).
   - **Descargas**: artículos destacados, una categoría completa, al azar, una lista de títulos
     o *toda* la Wikipedia (reanudable, pero muy lento por la API).
   - **Todo de una vez**: descarga el volcado oficial HTML de Wikimedia
     (`https://dumps.wikimedia.org/other/enterprise_html/runs/` → `eswiki-NS0-…-ENTERPRISE-HTML.json.tar.gz`)
     e impórtalo desde *Descargas → Importar*. Se procesa en streaming y se guarda comprimido.

Sin conexión funcionan la lectura, la búsqueda por título, el artículo al azar y la lectura en voz alta
con las voces del dispositivo.

## Voz
- **Voz del dispositivo**: Web Speech API, 100 % sin conexión si el sistema tiene voces instaladas.
- **Voz clonada**: en *Ajustes → Voz* subes un audio de muestra y se crea una voz con ElevenLabs
  (necesita cuenta y clave de API). Generar audio nuevo requiere internet; todo lo ya escuchado queda
  guardado y se reproduce sin conexión. Usa solo voces propias o con permiso de la persona.
- Selecciona cualquier texto de un artículo y pulsa **🔊 Leer selección**.

Contenido de Wikipedia bajo licencia CC BY-SA 4.0.
