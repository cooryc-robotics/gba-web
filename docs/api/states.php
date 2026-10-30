<?php
/* states.php — estados rápidos en la nube (premium).
 *
 *   GET  states.php?key=K             → { slots: [{ slot, size, updated_at }] }
 *   GET  states.php?key=K&slot=N      → bytes del estado (404 si está vacío)
 *   POST states.php?key=K&slot=N      cuerpo: bytes del estado (comprimido por el cliente)
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

$user = require_premium();
$key = game_key();
$slot = isset($_GET['slot']) ? (int)$_GET['slot'] : null;
if ($slot !== null && ($slot < 1 || $slot > STATE_SLOTS)) fail(400, 'Hueco no válido');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if ($slot === null) {
        $st = db()->prepare('SELECT slot, LENGTH(data) AS size, UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at FROM states WHERE user_id = ? AND save_key = ? ORDER BY slot');
        $st->execute([$user['id'], $key]);
        $rows = array_map(fn($r) => ['slot' => (int)$r['slot'], 'size' => (int)$r['size'], 'updated_at' => (int)$r['updated_at']], $st->fetchAll());
        json_out(200, ['slots' => $rows]);
    }
    $st = db()->prepare('SELECT data FROM states WHERE user_id = ? AND save_key = ? AND slot = ?');
    $st->execute([$user['id'], $key, $slot]);
    $data = $st->fetchColumn();
    if ($data === false) fail(404, 'Hueco vacío');
    header('Content-Type: application/octet-stream');
    echo $data;
    exit;
}

require_post();
if ($slot === null) fail(400, 'Falta el hueco');
$data = file_get_contents('php://input');
if ($data === false || $data === '' || strlen($data) > MAX_STATE_BYTES) fail(413, 'Estado no válido');

db()->prepare('INSERT INTO states (user_id, save_key, slot, data, updated_at) VALUES (?, ?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()')
    ->execute([$user['id'], $key, $slot, $data]);
json_out(200, ['ok' => true]);
