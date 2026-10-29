FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EXAM_APP_ROOT=/app

WORKDIR /app

COPY server.py /app/server.py
COPY public/ /app/public/
COPY data/seed-questions.json /app/data/seed-questions.json

EXPOSE 8787

CMD ["python", "/app/server.py"]
