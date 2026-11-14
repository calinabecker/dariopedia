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
   - **Paquete completo sin imágenes** (lo recomendado): ver abajo.

## Paquete sin imágenes (poco espacio)
`tools/crear_paquete.py` convierte el volcado oficial de Wikimedia en archivos `.ndjson.gz` de solo texto
(sin imágenes, tablas, fichas ni referencias). Solo necesita Python 3:

```
python3 tools/crear_paquete.py                  # modo resumen: introducción de cada artículo (≈ cientos de MB)
python3 tools/crear_paquete.py --modo completo  # texto entero sin secciones de relleno (varios GB)
```
Descarga ~5 GB de volcado y tarda una o dos horas. Después, en la app: *Descargas → Paquete → elegir los archivos*.
Si copias la carpeta `paquete/` junto a la app en tu hosting, el botón *Descargar paquete de este sitio* los baja solo.
En modo resumen cada archivo pesa unos 25 MB y todo cabe en GitHub Pages. El modo completo es demasiado grande para alojarlo ahí (copia los archivos al móvil a mano).

Sin conexión funcionan la lectura, la búsqueda por título, el artículo al azar y la lectura en voz alta
con las voces del dispositivo.

## Voz
- **Voz del dispositivo**: Web Speech API, 100 % sin conexión si el sistema tiene voces instaladas.
- **Voz clonada**: en *Ajustes → Voz* subes un audio de muestra y se crea una voz con ElevenLabs
  (necesita cuenta y clave de API). Generar audio nuevo requiere internet; todo lo ya escuchado queda
  guardado y se reproduce sin conexión. Usa solo voces propias o con permiso de la persona.
- Selecciona cualquier texto de un artículo y pulsa **🔊 Leer selección**.

Contenido de Wikipedia bajo licencia CC BY-SA 4.0.
