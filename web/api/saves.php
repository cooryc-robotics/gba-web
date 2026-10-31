<?php
/* saves.php — partidas guardadas del usuario con sesión iniciada.
 *
 *   GET  saves.php                    → { saves: [{ key, size, updated_at }], limit }
 *   GET  saves.php?key=K              → bytes de la partida (404 si no hay)
 *   POST saves.php?key=K              cuerpo: bytes de la partida
 *   POST saves.php?key=K&action=delete borra la partida y su historial
 *   GET  saves.php?key=K&history=1    → { versions: [{ id, size, saved_at }] }   (premium)
 *   GET  saves.php?key=K&version=ID   → bytes de esa versión                     (premium)
 *
 * El cliente quita los 0xFF del final (zona sin usar) antes de enviar, así
 * que lo guardado suele ser mucho menor que los 128 KiB del bloque.
 * La cuenta gratis guarda en la nube hasta FREE_CLOUD_GAMES juegos.
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

$user = require_user();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (!isset($_GET['key'])) {
        $st = db()->prepare('SELECT save_key AS `key`, LENGTH(data) AS size, UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at FROM saves WHERE user_id = ? ORDER BY updated_at DESC');
        $st->execute([$user['id']]);
        $rows = array_map(fn($r) => ['key' => $r['key'], 'size' => (int)$r['size'], 'updated_at' => (int)$r['updated_at']], $st->fetchAll());
        json_out(200, ['saves' => $rows, 'limit' => $user['premium'] ? null : FREE_CLOUD_GAMES]);
    }
    $key = game_key();

    if (isset($_GET['history'])) {
        if (!$user['premium']) fail(402, 'Función premium');
        $st = db()->prepare('SELECT id, LENGTH(data) AS size, UNIX_TIMESTAMP(saved_at) * 1000 AS saved_at FROM save_history WHERE user_id = ? AND save_key = ? ORDER BY saved_at DESC, id DESC');
        $st->execute([$user['id'], $key]);
        $rows = array_map(fn($r) => ['id' => (int)$r['id'], 'size' => (int)$r['size'], 'saved_at' => (int)$r['saved_at']], $st->fetchAll());
        json_out(200, ['versions' => $rows]);
    }

    if (isset($_GET['version'])) {
        if (!$user['premium']) fail(402, 'Función premium');
        $st = db()->prepare('SELECT data FROM save_history WHERE user_id = ? AND save_key = ? AND id = ?');
        $st->execute([$user['id'], $key, (int)$_GET['version']]);
    } else {
        $st = db()->prepare('SELECT data FROM saves WHERE user_id = ? AND save_key = ?');
        $st->execute([$user['id'], $key]);
    }
    $data = $st->fetchColumn();
    if ($data === false) fail(404, 'Sin partida');
    header('Content-Type: application/octet-stream');
    echo $data;
    exit;
}

require_post();
$key = game_key();

if (($_GET['action'] ?? '') === 'delete') {
    db()->prepare('DELETE FROM saves WHERE user_id = ? AND save_key = ?')->execute([$user['id'], $key]);
    db()->prepare('DELETE FROM save_history WHERE user_id = ? AND save_key = ?')->execute([$user['id'], $key]);
    json_out(200, ['ok' => true]);
}

$data = file_get_contents('php://input');
if ($data === false || strlen($data) > MAX_SAVE_BYTES) fail(413, 'Partida demasiado grande');

if (!$user['premium']) {
    $st = db()->prepare('SELECT COUNT(*) AS n, SUM(save_key = ?) AS mine FROM saves WHERE user_id = ?');
    $st->execute([$key, $user['id']]);
    $r = $st->fetch();
    if (!(int)$r['mine'] && (int)$r['n'] >= FREE_CLOUD_GAMES) {
        fail(402, 'La cuenta gratis guarda ' . FREE_CLOUD_GAMES . ' juegos en la nube');
    }
}

db()->prepare('INSERT INTO saves (user_id, save_key, data, updated_at) VALUES (?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()')
    ->execute([$user['id'], $key, $data]);

// Historial (premium): una versión nueva como mucho cada HISTORY_MIN_GAP
// segundos; dentro de ese margen se actualiza la última (un guardado del
// juego llega en varias escrituras seguidas).
if ($user['premium']) {
    $st = db()->prepare('SELECT id, TIMESTAMPDIFF(SECOND, saved_at, NOW()) AS age FROM save_history WHERE user_id = ? AND save_key = ? ORDER BY saved_at DESC, id DESC LIMIT 1');
    $st->execute([$user['id'], $key]);
    $last = $st->fetch();
    if ($last && (int)$last['age'] < HISTORY_MIN_GAP) {
        db()->prepare('UPDATE save_history SET data = ? WHERE id = ?')->execute([$data, $last['id']]);
    } else {
        db()->prepare('INSERT INTO save_history (user_id, save_key, data, saved_at) VALUES (?, ?, ?, NOW())')
            ->execute([$user['id'], $key, $data]);
        // Solo se conservan las HISTORY_KEEP más recientes.
        $st = db()->prepare('SELECT id FROM save_history WHERE user_id = ? AND save_key = ? ORDER BY saved_at DESC, id DESC LIMIT 18446744073709551615 OFFSET ' . HISTORY_KEEP);
        $st->execute([$user['id'], $key]);
        $old = $st->fetchAll(PDO::FETCH_COLUMN);
        if ($old) {
            db()->prepare('DELETE FROM save_history WHERE id IN (' . implode(',', array_fill(0, count($old), '?')) . ')')->execute($old);
        }
    }
}

json_out(200, ['ok' => true]);
