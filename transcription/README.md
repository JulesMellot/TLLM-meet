# Serveur de transcription

Reconnaissance vocale pour la transcription des réunions de TLLM\*meet. Il tourne sur CPU, sans GPU.

- Modèle : [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
  (25 langues européennes, dont le français, licence CC-BY-4.0), converti en ONNX et quantifié en int8
  ([istupakov/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)),
  exécuté par [onnx-asr](https://github.com/istupakov/onnx-asr).
- API compatible OpenAI : `POST /v1/audio/transcriptions` (champs `file`, `model`, `language`, `response_format`).
  TLLM\*meet l'appelle comme il appellerait Whisper.
- L'audio reçu est décodé par ffmpeg (WebM/Opus, MP4/AAC de Safari, Ogg, WAV), reconnu, puis oublié.

## Pourquoi ce modèle

Parakeet ne génère pas le texte mot par mot comme Whisper : il est plusieurs fois plus rapide à précision
comparable, et il n'invente pas de phrases sur les silences (le « Sous-titres réalisés par la communauté
d'Amara.org » de Whisper). En int8, il pèse environ 700 Mo et tient dans 1,5 Go de mémoire.

Dans une réunion, une ou deux personnes parlent en même temps : c'est cette charge que le serveur porte,
pas le nombre de participants. Chaque navigateur n'envoie que les phrases dites micro ouvert.

## Réglages

| Variable           | Défaut | Rôle                                                                                      |
| ------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `API_KEY`          | vide   | clé exigée dans `Authorization: Bearer …` (la même que `WHISPER_API_KEY` côté TLLM\*meet) |
| `ASR_THREADS`      | `0`    | cœurs CPU pour une phrase (`0` : onnxruntime choisit)                                     |
| `ASR_MAX_PARALLEL` | `2`    | phrases reconnues en même temps ; les autres attendent                                    |
| `ASR_MAX_BYTES`    | 25 Mo  | taille maximale d'un envoi                                                                |

Arguments de construction (`docker build --build-arg`) : `ASR_MODEL` (`nemo-parakeet-tdt-0.6b-v3`) et
`ASR_QUANTIZATION` (`int8` ; vide pour la version complète, plus lourde). Tout modèle pris en charge par onnx-asr
convient, par exemple `nemo-canary-1b-v2` (plus gros) ou `onnx-community/whisper-large-v3-turbo`.

## Sans Coolify

```bash
docker build -t tllm-transcription transcription/
docker run -d --name transcription -e API_KEY=une-clé-longue -p 127.0.0.1:8000:8000 tllm-transcription
```

Puis, dans le `.env` de TLLM\*meet :

```
WHISPER_ENABLED=true
WHISPER_BASE_PATH=http://127.0.0.1:8000/v1/
WHISPER_API_KEY=une-clé-longue
WHISPER_MODEL=parakeet
WHISPER_LANGUAGE=fr
```

Vérifier : `curl http://127.0.0.1:8000/health` répond `{"ok": true, …}`.
