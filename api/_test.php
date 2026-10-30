<?php
// Temporal para pruebas: se borra después. Protegido con token.
declare(strict_types=1);
require __DIR__ . '/lib.php';

$in = read_json();
if (!hash_equals('595b2b0413edd548854bb9eb1ce91cc10df0ff34ea54f766fa735aaaf1f1f0c0', hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'no');

$a = $in['action'] ?? '';
if ($a === 'cfg') {
    $cfg = config();
    if ($in['on']) $cfg['mollie'] = ['key' => 'test_mock', 'api' => 'https://gba.cooryc.com/api/_mock.php?p='];
    else unset($cfg['mollie']);
    file_put_contents(CONFIG_FILE, "<?php\nreturn " . var_export($cfg, true) . ";\n", LOCK_EX);
    json_out(200, ['ok' => true, 'keys' => array_keys($cfg)]);
}
if ($a === 'status') {
    $f = sys_get_temp_dir() . '/gbamock_' . preg_replace('/\W/', '', (string)$in['id']);
    $p = json_decode((string)file_get_contents($f), true);
    foreach ((array)$in['set'] as $k => $v) $p[$k] = $v;
    file_put_contents($f, json_encode($p));
    json_out(200, $p);
}
if ($a === 'orders') {
    $st = db()->prepare('SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id WHERE u.username = ?');
    $st->execute([(string)$in['username']]);
    json_out(200, ['orders' => $st->fetchAll()]);
}
if ($a === 'cleanup') {
    db()->prepare("DELETE FROM users WHERE username LIKE 'prueba\_%'")->execute();
    foreach (glob(sys_get_temp_dir() . '/gbamock_*') as $f) unlink($f);
    json_out(200, ['ok' => true]);
}
fail(400, '?');
