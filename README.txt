MINISTERIO DE ALABANZA — ETAPA 2B (NUBE)

Inicia sesión con tu cuenta Supabase, ya configurada en config.js.
Las canciones nuevas, PDF, Word, imágenes y acordes se guardan en Supabase Storage y en las tablas protegidas por RLS.
Los servicios y repertorios se guardan en Supabase.

1. Extrae el ZIP y abre la carpeta ministerio-alabanza en VS Code.
2. Desde esa carpeta ejecuta: python -m http.server 8000
3. Entra a http://localhost:8000 e inicia sesión.
4. Importa un PDF pequeño y comprueba que aparece en Biblioteca y Storage > canciones.
5. Haz clic en PDF para abrir el documento con un enlace temporal autorizado.

IMPORTANTE: los documentos antiguos de IndexedDB en la etapa anterior NO se borran ni se migran por sí solos. Si necesitas pasarlos a la nube, vuelve a importarlos desde el dispositivo original, usando el botón Importar varios. No borres los datos del navegador anterior.
No pongas claves service_role o sb_secret en el navegador.
Para ver canciones desde otro dispositivo, necesitarás publicar el sitio en HTTPS (Vercel) y autorizar el usuario de ese dispositivo.
Si un archivo no se carga, comprueba políticas RLS en tablas, miembros, y Storage. Las cuentas no autorizadas no pueden acceder.
Los documentos DOC/DOCX se descargan y se abren con una app compatible en el dispositivo.
La prueba de apertura de pestañas depende de los permisos del navegador.
