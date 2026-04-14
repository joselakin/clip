# Security Access Plan (Single-User)

## Context
Aplikasi ini ditujukan untuk penggunaan pribadi (single-user), jadi tidak perlu menambah tabel `users` atau fitur CRUD user.

## Goal
Membatasi akses web dengan password global yang aman, sederhana, dan mudah dirawat.

## Architecture Choice
1. Gunakan login gate dengan satu password global.
2. Simpan hash password di environment variable, bukan plaintext.
3. Gunakan session cookie `HttpOnly` untuk autentikasi.
4. Lindungi route menggunakan middleware.

## Implementation Plan

### Phase 1 - Environment Setup
1. Tambahkan env var:
   - `APP_PASSWORD_HASH`: hash Argon2/Bcrypt.
   - `SESSION_SECRET`: secret untuk sign session token.
   - `SESSION_TTL_HOURS`: masa berlaku session.
2. Pastikan `.env` tidak pernah ter-commit.

### Phase 2 - Auth Endpoints
1. `POST /api/auth/login`
   - Input: password.
   - Verifikasi dengan Argon2/Bcrypt verify.
   - Jika valid, set cookie session (`HttpOnly`, `Secure`, `SameSite=Lax`).
2. `POST /api/auth/logout`
   - Hapus/invalidate cookie.
3. `GET /api/auth/me` (opsional)
   - Return status login untuk frontend.

### Phase 3 - Route Protection
1. Tambahkan `middleware.ts` untuk memproteksi route app.
2. Izinkan path publik minimal:
   - `/login`
   - static assets (`/_next`, `/favicon.ico`, dll).
3. Jika belum login, redirect ke `/login`.

### Phase 4 - Basic Hardening
1. Tambahkan rate limit login (contoh: 5 percobaan/15 menit/IP).
2. Catat audit log ringan:
   - login success/fail,
   - logout,
   - IP dan waktu.
3. Gunakan constant-time comparison pada validasi credential.

### Phase 5 - Optional Perimeter Security
1. Pertimbangkan layer tambahan di depan app:
   - Cloudflare Access,
   - Tailscale Funnel,
   - Nginx Basic Auth.
2. Kombinasi perimeter + app-level gate direkomendasikan untuk keamanan lebih tinggi.

## Data & DB Impact
1. Tidak perlu tabel `users`.
2. Tidak ada perubahan schema Prisma yang wajib untuk skenario ini.
3. Jika ingin audit lebih lengkap ke depan, bisa tambah tabel `auth_events` (opsional).

## Acceptance Criteria
1. Semua halaman utama hanya bisa diakses setelah login.
2. Password tidak pernah disimpan plaintext.
3. Session cookie tidak bisa diakses JavaScript (`HttpOnly`).
4. Login endpoint memiliki rate limiting.

## Rollout Notes
1. Mulai dari dev environment.
2. Uji login/logout dan redirect middleware.
3. Deploy setelah env var produksi siap.
