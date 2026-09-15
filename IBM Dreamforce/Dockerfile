FROM python:3.11-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
# footage is mounted at runtime (see docker-compose.yml)
ENV DRONE_VIDEO=/srv/footage/powerline-demo-1080_2k_full.mp4
EXPOSE 8000
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8000"]
