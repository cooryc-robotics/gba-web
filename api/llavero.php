<?php
/* llavero.php — llaveros NFC que dan Premium.
 *
 * Cada llavero lleva grabada la dirección https://gba.cooryc.com/?llavero=CÓDIGO
 * y el código impreso (XXXX-XXXX-XXXX), por si el móvil no tiene NFC. Vale
 * para una sola cuenta. En la base de datos solo está el sha256 del código.
 *
 *   POST llavero.php   { code }   activa Premium en la cuenta de la sesión
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

require_post();
$user = require_user();
check_fails();

// Mayúsculas y sin guiones ni espacios; alfabeto sin 0/O ni 1/I.
$code = strtoupper(preg_replace('/[\s-]+/', '', (string)(read_json()['code'] ?? '')));
if (!preg_match('/^[2-9A-HJ-NP-Z]{12}$/', $code)) {
    note_fail();
    fail(400, 'Ese código no es válido. Son 12 letras y números, como ABCD-EFGH-JKLM.');
}
$hash = hash('sha256', $code);

$st = db()->prepare('SELECT redeemed_by FROM premium_codes WHERE code_hash = ?');
$st->execute([$hash]);
$row = $st->fetch();
if (!$row) {
    note_fail();
    fail(404, 'Ese llavero no existe. Revisa el código.');
}
if ((int)$row['redeemed_by'] === $user['id']) {
    json_out(200, ['user' => $user, 'already' => true]); // ya lo activó esta cuenta
}
if ($row['redeemed_by'] !== null) fail(409, 'Este llavero ya se ha usado en otra cuenta.');
if ($user['premium']) fail(409, 'Ya eres Premium, así que el llavero no se ha gastado: puedes regalarlo.');

$pdo = db();
$pdo->beginTransaction();
$st = $pdo->prepare('UPDATE premium_codes SET redeemed_by = ?, redeemed_at = NOW() WHERE code_hash = ? AND redeemed_by IS NULL');
$st->execute([$user['id'], $hash]);
if ($st->rowCount() !== 1) {
    $pdo->rollBack();
    fail(409, 'Este llavero ya se ha usado en otra cuenta.');
}
$pdo->prepare('UPDATE users SET premium_at = COALESCE(premium_at, NOW()) WHERE id = ?')->execute([$user['id']]);
$pdo->commit();

json_out(200, ['user' => array_merge($user, ['premium' => true])]);
