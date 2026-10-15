"""Единая точка работы с нейросетью. В остальном коде вызывайте только ask_llm().

Провайдер выбирается переменной LLM_PROVIDER в .env:
  gigachat — GigaChat (Сбер)
  yandex   — YandexGPT (Yandex AI Studio)
  openai   — любой OpenAI-совместимый API (OPENAI_BASE_URL)
  пусто    — заглушка, чтобы приложение работало без ключей
"""

import os

from openai import OpenAI

NOT_CONFIGURED = "ИИ не подключён: заполните LLM_PROVIDER и ключ в .env (пример в .env.example)."


def provider() -> str:
    return os.getenv("LLM_PROVIDER", "").strip().lower()


def ask_llm(prompt: str, system: str | None = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    match provider():
        case "gigachat":
            return _gigachat(messages)
        case "yandex":
            folder = os.environ["YANDEX_FOLDER_ID"]
            client = OpenAI(
                api_key=os.environ["YANDEX_API_KEY"],
                base_url="https://llm.api.cloud.yandex.net/v1",
                project=folder,
                timeout=60,
            )
            model = f"gpt://{folder}/{os.getenv('YANDEX_MODEL', 'yandexgpt-lite/latest')}"
            return _openai_chat(client, model, messages)
        case "openai":
            client = OpenAI(
                api_key=os.environ["OPENAI_API_KEY"],
                base_url=os.getenv("OPENAI_BASE_URL") or None,
                timeout=60,
            )
            return _openai_chat(client, os.getenv("OPENAI_MODEL", "gpt-4o-mini"), messages)
        case _:
            return NOT_CONFIGURED


def _openai_chat(client: OpenAI, model: str, messages: list[dict]) -> str:
    response = client.chat.completions.create(model=model, messages=messages, temperature=0.3)
    return response.choices[0].message.content or ""


def _gigachat(messages: list[dict]) -> str:
    from gigachat import GigaChat

    # Сертификаты GigaChat выпущены НУЦ Минцифры. Для проверки TLS скачайте корневой
    # сертификат (russian_trusted_root_ca.cer) и укажите путь в GIGACHAT_CA_BUNDLE.
    ca_bundle = os.getenv("GIGACHAT_CA_BUNDLE") or None
    with GigaChat(
        credentials=os.environ["GIGACHAT_CREDENTIALS"],
        scope=os.getenv("GIGACHAT_SCOPE", "GIGACHAT_API_PERS"),
        model=os.getenv("GIGACHAT_MODEL", "GigaChat"),
        ca_bundle_file=ca_bundle,
        verify_ssl_certs=ca_bundle is not None,
        timeout=60,
    ) as giga:
        response = giga.chat({"messages": messages, "temperature": 0.3})
    return response.choices[0].message.content or ""
