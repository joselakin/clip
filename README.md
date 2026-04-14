# Clipper Web

Aplikasi web untuk mengubah video panjang menjadi short clip vertikal (9:16) secara semi-otomatis menggunakan pipeline AI:

1. Ingest video (upload lokal atau import YouTube)
2. Transkripsi audio (Groq Whisper)
3. Seleksi highlight (Groq GPT-OSS)
4. Evaluasi kualitas clip + rekomendasi judul (Groq GPT-OSS)
5. Face-aware crop ke portrait + render clip + subtitle burn-in + thumbnail
6. Review hasil di Library (preview, score, download)

---

## 1) Gambaran Teknologi

- Frontend/Backend: Next.js (App Router) + React + TypeScript
- Database: PostgreSQL + Prisma ORM
- Video processing: FFmpeg + ffprobe
- AI/STT: Groq (Whisper untuk transkripsi, GPT-OSS untuk highlight + scoring)
- Face crop helper: Python (OpenCV)

---

## 2) Prasyarat Sebelum Install

Pastikan mesin kamu sudah punya:

1. Node.js 20+ dan npm
2. PostgreSQL 14+ (atau setara)
3. FFmpeg dan ffprobe (harus bisa dipanggil dari terminal)
4. Python 3.10+ (disarankan 3.11/3.12)
5. Git

Opsional tapi direkomendasikan:

- yt-dlp untuk fallback download YouTube
- Font Montserrat ExtraBold (jika ingin hasil subtitle ASS sesuai style)

Contoh instalasi cepat di Linux (Ubuntu/Debian):

```bash
sudo apt update
sudo apt install -y ffmpeg python3 python3-venv python3-pip postgresql postgresql-contrib
python3 --version
ffmpeg -version
ffprobe -version
```

---

## 3) Clone dan Install Dependency

```bash
git clone <repo-url>
cd clipper-web
npm install
```

---

## 4) Setup Environment (.env)

Copy template environment:

```bash
cp .env.example .env
```

Lalu isi nilai penting berikut di .env:

1. DATABASE_URL
2. APP_PASSWORD
3. SESSION_SECRET
4. CREDENTIAL_ENCRYPTION_KEY
5. Path binary bila tidak ada di PATH (FFMPEG_PATH, FFPROBE_PATH, PYTHON_BIN)

Contoh minimal (sesuaikan dengan mesin kamu):

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/clipper_web?schema=public"
APP_PASSWORD="ganti-password-login"
SESSION_SECRET="ganti-dengan-random-string-panjang"
CREDENTIAL_ENCRYPTION_KEY="ganti-dengan-random-string-panjang"

FFMPEG_PATH="ffmpeg"
FFPROBE_PATH="ffprobe"
PYTHON_BIN=".venv/bin/python"
FACE_CROP_SCRIPT_PATH="face-detection/crop_plan.py"

GROQ_TRANSCRIBE_MODEL="whisper-large-v3-turbo"
GROQ_HIGHLIGHT_MODEL="openai/gpt-oss-120b"
GROQ_CHAT_ENDPOINT="https://api.groq.com/openai/v1/chat/completions"
```

Catatan penting:

- Jangan commit file .env ke GitHub.
- Untuk source YouTube yang sering kena blokir, siapkan cookie file dan isi YOUTUBE_COOKIES_FILE.
- Untuk transkripsi video panjang, parameter ini penting:
  - GROQ_TRANSCRIBE_MAX_UPLOAD_BYTES
  - GROQ_TRANSCRIBE_CHUNK_SECONDS

---

## 5) Setup Database (Prisma)

Jalankan migrasi dan generate Prisma client:

```bash
npm run prisma:generate
npm run prisma:migrate:dev
```

Cek status migrasi:

```bash
npm run prisma:migrate:status
```

Opsional (lihat isi data):

```bash
npm run prisma:studio
```

---

## 6) Setup Python (Face Crop + Test)

Buat virtual env dan install dependency python:

```bash
npm run py:test:setup
```

Script ini akan:

1. Membuat .venv jika belum ada
2. Upgrade pip
3. Install yt-dlp + pytube
4. Install requirement face detection (opencv-python, numpy, pytest)

Jika kamu ingin cek cepat test python face-crop:

```bash
npm run test:face-crop:python
```

---

## 7) Jalankan Aplikasi

Mode development:

```bash
npm run dev
```

Buka:

http://localhost:3000

---

## 8) Alur Pertama Kali Pakai (Wajib)

1. Login ke aplikasi memakai APP_PASSWORD dari .env
2. Buka dashboard
3. Simpan Groq API key di panel Configuration (format key harus diawali gsk_)
4. Pilih source video:
	- Upload file lokal, atau
	- URL YouTube
5. Klik proses pipeline
6. Cek hasil di halaman Library

---

## 9) Pipeline Internal (Ringkas)

1. Ingest
	- Upload: simpan file ke storage lokal
	- YouTube: download via ytdl-core, fallback yt-dlp jika perlu
2. Probe metadata video (durasi, codec, resolusi)
3. Ekstrak audio 16 kHz mono WAV
4. Transkripsi Groq
	- Jika file audio kecil: kirim langsung
	- Jika terlalu besar: auto split per chunk, transkrip per chunk, lalu merge timestamp
5. AI highlight selection (maks 6 kandidat)
6. AI clip evaluation
	- Rekomendasi judul
	- Skor kualitas konten
	- Rationale + improvement tip
7. Render clip
	- Crop portrait 1080x1920
	- Burn subtitle ASS (karaoke)
	- Generate thumbnail
8. Tampilkan hasil di Library

---

## 10) Struktur Folder Penting

- src/app/api/videos: endpoint ingest/transcribe/highlight/render
- src/lib/media.ts: FFmpeg helper
- src/lib/groq.ts: integrasi Groq (transcribe, highlight, evaluasi)
- src/lib/subtitles.ts: generator subtitle ASS karaoke
- face-detection: script python face crop
- prisma: schema + migration
- storage: output file lokal (uploads, clips, thumbnails, subtitles, dst)

---

## 11) Command Harian yang Sering Dipakai

```bash
# dev server
npm run dev

# lint
npm run lint

# prisma
npm run prisma:generate
npm run prisma:migrate:dev
npm run prisma:migrate:status

# youtube diagnostics
npm run test:youtube:downloaders -- <youtube-url>
npm run test:youtube:python

# python face-crop test
npm run py:test:setup
npm run test:face-crop:python
```

---

## 12) Troubleshooting Umum

### A) Error Groq 413 Request Entity Too Large

Gejala:

- Groq transcription gagal (413): request_too_large

Solusi:

1. Pastikan env chunking terisi
2. Kecilkan durasi chunk

Contoh:

```env
GROQ_TRANSCRIBE_MAX_UPLOAD_BYTES="25165824"
GROQ_TRANSCRIBE_CHUNK_SECONDS="300"
```

### B) Error YouTube 429 / bot check

Solusi:

1. Isi YOUTUBE_COOKIES_FILE dengan cookie yang valid
2. Aktifkan fallback yt-dlp
3. Gunakan proxy jika diperlukan

### C) FFmpeg/ffprobe tidak ditemukan

Gejala:

- Perintah ffmpeg gagal dijalankan
- Gagal membaca metadata video

Solusi:

1. Install ffmpeg
2. Isi FFMPEG_PATH dan FFPROBE_PATH dengan path binary yang benar

### D) Python/OpenCV error (contoh: ModuleNotFoundError: cv2)

Solusi:

```bash
npm run py:test:setup
```

Lalu pastikan PYTHON_BIN di .env mengarah ke .venv/bin/python.

### E) Subtitle font tidak sesuai

Solusi:

1. Install font Montserrat ExtraBold di OS, atau
2. Set SUBTITLE_FONTS_DIR ke folder font custom untuk FFmpeg libass

---

## 13) Keamanan dan Hal yang Wajib Diperhatikan

1. Jangan pernah commit:
	- .env
	- cookie YouTube
	- API key plaintext
2. Ganti APP_PASSWORD dari default
3. Gunakan SESSION_SECRET dan CREDENTIAL_ENCRYPTION_KEY yang kuat
4. Pastikan storage folder punya permission aman
5. Untuk production, aktifkan HTTPS dan perketat akses server

---

## 14) Checklist Install Cepat (Ringkas)

```bash
npm install
cp .env.example .env
# edit .env
npm run prisma:generate
npm run prisma:migrate:dev
npm run py:test:setup
npm run dev
```

Setelah server hidup:

1. Login dengan APP_PASSWORD
2. Simpan Groq API key di Configuration
3. Uji proses 1 video dari dashboard

---

## 15) Catatan Operasional

- Output clip saat ini dirender ke format portrait 1080x1920 (9:16).
- Library sudah dioptimasi untuk loading bertahap supaya tidak berat saat clip banyak.
- AI scoring title/quality ditampilkan di kartu clip berdasarkan hasil evaluasi model GPT-OSS.
