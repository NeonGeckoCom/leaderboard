# Static dashboard served on the port Hugging Face Spaces expects (7860).
# The app is a single HTML page + precomputed data; no backend logic is needed,
# so a tiny static file server is all that's required.
FROM python:3.12-slim

WORKDIR /app

# Only the files the browser actually needs.
COPY index.html app.js data.js data.json ./

EXPOSE 7860

# Serve from /app on 0.0.0.0:7860. index.html is returned for "/".
CMD ["python", "-m", "http.server", "7860", "--bind", "0.0.0.0"]
