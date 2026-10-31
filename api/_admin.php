<?php
// Temporal: borra las cuentas de prueba. Se borra después. Protegido con token.
declare(strict_types=1);
require __DIR__ . '/lib.php';
$in = read_json();
if (!hash_equals('595b2b0413edd548854bb9eb1ce91cc10df0ff34ea54f766fa735aaaf1f1f0c0', hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'no');
$st = db()->query("SELECT r.sha256 FROM roms r JOIN users u ON u.id = r.user_id WHERE u.username LIKE 'prueba\_%'");
$shas = $st->fetchAll(PDO::FETCH_COLUMN);
$st = db()->prepare("DELETE FROM users WHERE username LIKE 'prueba\_%'");
$st->execute();
rom_gc($shas);
json_out(200, ['deleted' => $st->rowCount()]);
