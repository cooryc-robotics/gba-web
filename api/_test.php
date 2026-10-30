<?php
// Temporal para pruebas: se borra después. Protegido con token.
declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/redsys-lib.php';

$in = read_json();
if (!hash_equals('9eea7d0194bc57da9f0dba7a245b90bb52f637cd419d22f25d6be45533b4fa9c', hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'no');

$a = $in['action'] ?? '';
if ($a === 'sign') {
    json_out(200, ['sig' => redsys_signature((string)$in['key'], (string)$in['order'], (string)$in['params'])]);
}
if ($a === 'premium') {
    db()->prepare('UPDATE users SET premium_at = ' . ($in['on'] ? 'NOW()' : 'NULL') . ' WHERE username = ?')->execute([(string)$in['username']]);
    json_out(200, ['ok' => true]);
}
if ($a === 'notify') {
    // Simula la notificación de Redsys firmando con la clave dada.
    $params = base64_encode(json_encode($in['params']));
    $_POST = ['Ds_SignatureVersion' => 'HMAC_SHA256_V1', 'Ds_MerchantParameters' => $params,
              'Ds_Signature' => strtr(redsys_signature((string)$in['key'], (string)$in['params']['Ds_Order'], $params), '+/', '-_')];
    json_out(200, ['post' => $_POST]);
}
if ($a === 'cfg') {
    // Pone o quita en la configuración el comercio de PRUEBAS público de Redsys.
    $cfg = config();
    if ($in['on']) {
        $cfg['redsys'] = ['merchant' => '999008881', 'terminal' => '1', 'key' => 'sq7HjrUOBfKmC576ILgskD5srU870gJ7', 'live' => false];
    } else {
        unset($cfg['redsys']);
    }
    file_put_contents(CONFIG_FILE, "<?php\nreturn " . var_export($cfg, true) . ";\n", LOCK_EX);
    json_out(200, ['ok' => true, 'keys' => array_keys($cfg)]);
}
if ($a === 'cleanup') {
    db()->prepare("DELETE FROM users WHERE username LIKE 'prueba\\_%'")->execute();
    json_out(200, ['ok' => true]);
}
fail(400, '?');
