<?php
// Temporal: activa premium a una cuenta. Se borra después. Protegido con token.
declare(strict_types=1);
require __DIR__ . '/lib.php';
$in = read_json();
if (!hash_equals('595b2b0413edd548854bb9eb1ce91cc10df0ff34ea54f766fa735aaaf1f1f0c0', hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'no');
$u = (string)($in['username'] ?? '');
db()->prepare('UPDATE users SET premium_at = COALESCE(premium_at, NOW()) WHERE username = ?')->execute([$u]);
$st = db()->prepare('SELECT id, username, premium_at FROM users WHERE username = ?');
$st->execute([$u]);
json_out(200, ['user' => $st->fetch() ?: null]);
