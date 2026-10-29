<?php
/* saves.php — partidas guardadas del usuario con sesión iniciada.
 *
 *   GET  saves.php             → { saves: [{ key, size, updated_at }] }
 *   GET  saves.php?key=K       → bytes de la partida (404 si no hay)
 *   POST saves.php?key=K       cuerpo: bytes de la partida
 *
 * El cliente quita los 0xFF del final (zona sin usar) antes de enviar, así
 * que lo guardado suele ser mucho menor que los 128 KiB del bloque.
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

$user = require_user();
$key = $_GET['key'] ?? null;

if ($key !== null && (!is_string($key) || $key === '' || strlen($key) > 255)) fail(400, 'Clave no válida');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if ($key === null) {
        $st = db()->prepare('SELECT save_key AS `key`, LENGTH(data) AS size, UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at FROM saves WHERE user_id = ? ORDER BY updated_at DESC');
        $st->execute([$user['id']]);
        $rows = array_map(fn($r) => ['key' => $r['key'], 'size' => (int)$r['size'], 'updated_at' => (int)$r['updated_at']], $st->fetchAll());
        json_out(200, ['saves' => $rows]);
    }
    $st = db()->prepare('SELECT data FROM saves WHERE user_id = ? AND save_key = ?');
    $st->execute([$user['id'], $key]);
    $data = $st->fetchColumn();
    if ($data === false) fail(404, 'Sin partida');
    header('Content-Type: application/octet-stream');
    echo $data;
    exit;
}

require_post();
if ($key === null) fail(400, 'Falta la clave');

$data = file_get_contents('php://input');
if ($data === false || strlen($data) > MAX_SAVE_BYTES) fail(413, 'Partida demasiado grande');

db()->prepare('INSERT INTO saves (user_id, save_key, data, updated_at) VALUES (?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()')
    ->execute([$user['id'], $key, $data]);
json_out(200, ['ok' => true]);
