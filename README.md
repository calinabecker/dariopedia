# Dariopedia

Enciclopedia instalable (PWA) que funciona **sin conexión**: ~2 millones de artículos y ~2 millones de
redirecciones en español, solo texto, unos 320 MB.

## Usarla
1. Abre https://calinabecker.github.io/dariopedia/ en Safari (iPhone) o Chrome (Android).
2. Añádela a la pantalla de inicio y **ábrela desde el icono**.
3. Con wifi, se descarga sola (≈ 1–3 minutos). Después funciona sin internet.

Sin conexión: búsqueda por título (con redirecciones: «Gato» → «Felis catus»), lectura, artículo aleatorio y
lectura en voz alta. Con conexión, «Ver artículo completo» trae el artículo entero con imágenes.

## Cómo funciona
- `datos/` contiene bloques `bNNNN.gz` (~400 KB) con los títulos **ordenados** e `indice.json`.
- La app descarga los bloques como archivos sueltos a Cache Storage (en paralelo, con reintentos, comprobando
  el tamaño; si se corta, continúa por donde iba). Para leer, busca en el índice y abre **un** bloque.
- No hay base de datos que escribir en el móvil: es rápido, ligero y no se cuelga.

## Regenerar los datos
```
python3 tools/crear_paquete.py                        # volcado oficial → paquete/ (resúmenes)
python3 tools/crear_paquete.py --solo-redirecciones   # redirecciones → paquete/
python3 tools/indexar.py --entrada paquete --salida datos
```
`crear_paquete.py` descarga ~5 GB (reanudable). Todo usa solo la biblioteca estándar de Python.

## Voz
- **Voz del dispositivo**: Web Speech API, sin conexión.
- **Voz clonada**: Ajustes → Voz, con una muestra de audio y una clave de API de ElevenLabs. Generar audio nuevo
  necesita internet; lo ya escuchado queda guardado. Usa solo voces propias o con permiso.

Contenido bajo licencia CC BY-SA 4.0.
