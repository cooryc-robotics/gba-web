<?php
/* roms.php — los juegos de cada usuario, guardados en el servidor.
 *
 *   GET  roms.php                         → { roms: [{name, size, sha}], max }
 *   GET  roms.php?sha=…                   → bytes del ROM (si es del usuario)
 *   POST roms.php?name=juego.gba          cuerpo: bytes del ROM → { rom }
 *   POST roms.php?action=delete&name=…    lo quita de la cuenta
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

$user = require_user();

function list_roms(int $userId): array {
    $st = db()->prepare('SELECT name, size, sha256 AS sha FROM roms WHERE user_id = ? ORDER BY name');
    $st->execute([$userId]);
    return array_map(fn($r) => ['name' => $r['name'], 'size' => (int)$r['size'], 'sha' => $r['sha']], $st->fetchAll());
}

function rom_name(): string {
    $name = trim((string)($_GET['name'] ?? ''));
    if ($name === '' || mb_strlen($name) > 200 || strpbrk($name, '/\\') !== false || preg_match('/[\x00-\x1f]/', $name)
        || !preg_match('/\.(gba|gb|gbc)$/i', $name)) fail(400, 'Nombre de juego no válido');
    return $name;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $sha = (string)($_GET['sha'] ?? '');
    if ($sha === '') json_out(200, ['roms' => list_roms($user['id']), 'max' => MAX_ROMS_PER_USER]);

    if (!preg_match('/^[0-9a-f]{64}$/', $sha)) fail(400, 'Juego no válido');
    $st = db()->prepare('SELECT 1 FROM roms WHERE user_id = ? AND sha256 = ? LIMIT 1');
    $st->execute([$user['id'], $sha]);
    if (!$st->fetchColumn() || !is_file(rom_path($sha))) fail(404, 'Juego no encontrado');
    // El contenido nunca cambia para un mismo sha: el navegador puede guardarlo en caché.
    header_remove('Cache-Control');
    header('Cache-Control: private, max-age=31536000, immutable');
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize(rom_path($sha)));
    readfile(rom_path($sha));
    exit;
}

require_post();

if (($_GET['action'] ?? '') === 'delete') {
    $name = rom_name();
    $st = db()->prepare('SELECT sha256 FROM roms WHERE user_id = ? AND name = ?');
    $st->execute([$user['id'], $name]);
    $sha = $st->fetchColumn();
    if ($sha) {
        db()->prepare('DELETE FROM roms WHERE user_id = ? AND name = ?')->execute([$user['id'], $name]);
        rom_gc([$sha]);
    }
    json_out(200, ['roms' => list_roms($user['id'])]);
}

$name = rom_name();
$st = db()->prepare('SELECT sha256 FROM roms WHERE user_id = ? AND name = ?');
$st->execute([$user['id'], $name]);
$oldSha = $st->fetchColumn();
if (!$oldSha) {
    $st = db()->prepare('SELECT COUNT(*) FROM roms WHERE user_id = ?');
    $st->execute([$user['id']]);
    if ((int)$st->fetchColumn() >= MAX_ROMS_PER_USER) fail(402, 'Has llegado al máximo de ' . MAX_ROMS_PER_USER . ' juegos');
}

// Se copia el cuerpo a un archivo temporal calculando el sha256 a la vez,
// sin cargar el ROM entero en memoria.
if (!is_dir(ROMS_DIR) && !mkdir(ROMS_DIR, 0700, true) && !is_dir(ROMS_DIR)) fail(500, 'No se pudo guardar');
$tmp = tempnam(ROMS_DIR, 'up');
$in = fopen('php://input', 'rb');
$out = fopen($tmp, 'wb');
$ctx = hash_init('sha256');
$size = 0;
while (!feof($in)) {
    $chunk = fread($in, 1 << 16);
    if ($chunk === false) break;
    $size += strlen($chunk);
    if ($size > MAX_ROM_BYTES) break;
    hash_update($ctx, $chunk);
    fwrite($out, $chunk);
}
fclose($in);
fclose($out);
$minSize = preg_match('/\.gba$/i', $name) ? 0xC0 : 0x150;
if ($size > MAX_ROM_BYTES || $size < $minSize) {
    unlink($tmp);
    fail(400, 'Ese archivo no parece un ROM válido');
}
$sha = hash_final($ctx);

$dest = rom_path($sha);
if (!is_dir(dirname($dest))) @mkdir(dirname($dest), 0700, true);
if (is_file($dest)) unlink($tmp);
elseif (!rename($tmp, $dest)) { @unlink($tmp); fail(500, 'No se pudo guardar'); }

db()->prepare('INSERT INTO roms (user_id, name, sha256, size, created_at) VALUES (?, ?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE name = VALUES(name), sha256 = VALUES(sha256), size = VALUES(size), created_at = NOW()')
    ->execute([$user['id'], $name, $sha, $size]);
if ($oldSha && $oldSha !== $sha) rom_gc([$oldSha]);

json_out(200, ['rom' => ['name' => $name, 'size' => $size, 'sha' => $sha]]);
