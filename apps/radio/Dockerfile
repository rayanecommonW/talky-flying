FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY radio radio
ENV PYTHONUNBUFFERED=1
CMD ["uv", "run", "--no-dev", "python", "-m", "radio.main", "start"]
