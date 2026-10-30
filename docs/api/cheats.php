<?php
/* cheats.php — códigos de trucos por juego (premium).
 *
 *   GET  cheats.php?key=K   → { codes: "texto, un código por línea" }
 *   POST cheats.php?key=K   { codes }
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

const MAX_CHEAT_CHARS = 16000; // cabe en el búfer de trucos del emulador

$user = require_premium();
$key = game_key();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $st = db()->prepare('SELECT codes FROM cheats WHERE user_id = ? AND save_key = ?');
    $st->execute([$user['id'], $key]);
    json_out(200, ['codes' => (string)($st->fetchColumn() ?: '')]);
}

require_post();
$codes = (string)(read_json()['codes'] ?? '');
if (strlen($codes) > MAX_CHEAT_CHARS) fail(413, 'Demasiados códigos');

if (trim($codes) === '') {
    db()->prepare('DELETE FROM cheats WHERE user_id = ? AND save_key = ?')->execute([$user['id'], $key]);
} else {
    db()->prepare('INSERT INTO cheats (user_id, save_key, codes) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE codes = VALUES(codes)')
        ->execute([$user['id'], $key, $codes]);
}
json_out(200, ['ok' => true]);
