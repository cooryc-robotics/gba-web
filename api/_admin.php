<?php
// Temporal: carga lotes de códigos de llavero (solo sha256). Se borra después. Protegido con token.
declare(strict_types=1);
require __DIR__ . '/lib.php';
$in = read_json();
if (!hash_equals('595b2b0413edd548854bb9eb1ce91cc10df0ff34ea54f766fa735aaaf1f1f0c0', hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'no');
$batch = (string)($in['batch'] ?? '');
if (!preg_match('/^[a-z0-9_-]{1,40}$/', $batch)) fail(400, 'lote');
if (($in['action'] ?? '') === 'delete') {
    $st = db()->prepare('DELETE FROM premium_codes WHERE batch = ?');
    $st->execute([$batch]);
    json_out(200, ['deleted' => $st->rowCount()]);
}
$st = db()->prepare('INSERT IGNORE INTO premium_codes (code_hash, batch, created_at) VALUES (?, ?, NOW())');
$n = 0;
foreach ((array)($in['hashes'] ?? []) as $h) {
    if (!is_string($h) || !preg_match('/^[0-9a-f]{64}$/', $h)) continue;
    $st->execute([$h, $batch]);
    $n += $st->rowCount();
}
$c = db()->query('SELECT batch, COUNT(*) n, SUM(redeemed_by IS NOT NULL) used FROM premium_codes GROUP BY batch')->fetchAll();
json_out(200, ['inserted' => $n, 'batches' => $c]);
