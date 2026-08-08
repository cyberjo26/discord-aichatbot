Bot mati tanpa jejak. Log terakhir adalah aksi bot biasa, lalu proses hilang tanpa `shutdown()`. Tiga penyebab yang harus kita kunci:

1. **Tidak ada handler gateway / error / rejection.**
   `src/index.js` tidak punya `client.on('error'/'shardError'/'disconnect'/'reconnecting'/'resume'/'warn')` atau `process.on('uncaughtException'/'unhandledRejection')`. Begitu Discord gateway error atau ada promise reject, proses bisa mati tanpa catatan.

2. **`SIGTERM` di Windows = abrupt kill.**
   Root `index.js` (supervisor) pakai `child.kill('SIGTERM')`. Di Windows `SIGTERM` bukan sinyal asli, Node terminate paksa child. `shutdown()` di `src/index.js:389` tidak pernah jalan, jadi tidak ada log "shutting down...". Restart kelihatan, shutdown tidak.

3. **Health check tidak periksa gateway.**
   `src/utils/health.js` cuma periksa AI dan DB. Kalau WebSocket Discord mati, status tetap `healthy`.

Rencana kecil (perubahan terisolasi):

A. `src/index.js` — tambah handler:
   - `client.on('error', e => logger.error(...))`
   - `client.on('shardError', e => logger.error(...))`
   - `client.on('warn', m => logger.warn(...))`
   - `client.on('disconnect', close => logger.warn(...))`
   - `client.on('reconnecting', () => logger.warn(...))`
   - `client.on('shardDisconnect', ...)` dan `client.on('resume', ...)` kalau ada.
   - `process.on('uncaughtException', err => { logger.error(...); exit = 1 })`
   - `process.on('unhandledRejection', err => logger.error(...))`
   - Tambahkan `logger.info('Gateway status: ...')` tiap 1 menit di interval yang sudah ada.
   - Saat shutdown, tulis `logger.info('Shutdown: reason=...')` sebelum `process.exit`.

B. `src/utils/health.js` — tambah cek gateway:
   - `client && client.ws.status` dibandingkan dengan `READY`. Laporkan ke field `checks.gateway`.

C. Root `index.js` — supervisornya juga harus menulis ke file log:
   - Pakai logger yang sama atau tulis ke `data/supervisor.log`.
   - Catat: spawn pid, exit code/signal, scheduled restart, kill attempt.

D. Logging format:
   - Format sudah cukup. Tidak perlu ubah.

Trade-off:
- Lebih banyak baris log, tapi itu tujuannya: bisa lihat mati karena apa.
- `uncaughtException` setelah log akan `process.exit(1)` agar supervisor restart child.
- `unhandledRejection` log saja, tidak exit, supaya tidak loop restart kalau ada promise noise.

Order implementasi: A → B → C. Tidak ada perubahan pada bisnis bot.