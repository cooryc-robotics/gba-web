<?php
/* redsys.php — notificación de Redsys al terminar un pago (la llama el
 * servidor de Redsys, no el navegador). Si la firma es válida y el pago se
 * autorizó, el pedido queda pagado y la cuenta pasa a premium. */

declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/redsys-lib.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'Método no permitido');

$rs = config()['redsys'] ?? null;
if (!$rs || empty($rs['key'])) fail(503, 'Pagos no configurados');

$paramsB64 = (string)($_POST['Ds_MerchantParameters'] ?? '');
$signature = (string)($_POST['Ds_Signature'] ?? '');
$params = json_decode((string)base64_decode(strtr($paramsB64, '-_', '+/')), true);
if (!is_array($params)) fail(400, 'Parámetros no válidos');

$order = (string)($params['Ds_Order'] ?? '');
if (!preg_match('/^[0-9]{4}[0-9a-zA-Z]{8}$/', $order)) fail(400, 'Pedido no válido');
if (!redsys_same_signature(redsys_signature((string)$rs['key'], $order, $paramsB64), $signature)) fail(403, 'Firma no válida');

$st = db()->prepare('SELECT user_id, amount_cents, status FROM orders WHERE order_id = ?');
$st->execute([$order]);
$row = $st->fetch();
if (!$row) fail(404, 'Pedido desconocido');

// Ds_Response entre 0000 y 0099 = pago autorizado.
$response = (int)($params['Ds_Response'] ?? 9999);
$ok = $response >= 0 && $response <= 99
    && (int)($params['Ds_Amount'] ?? -1) === (int)$row['amount_cents']
    && (string)($params['Ds_Currency'] ?? '') === '978'
    && ltrim((string)($params['Ds_MerchantCode'] ?? ''), '0') === ltrim((string)$rs['merchant'], '0');

if ($ok) {
    db()->prepare("UPDATE orders SET status = 'paid', paid_at = NOW(), auth_code = ? WHERE order_id = ?")
        ->execute([substr((string)($params['Ds_AuthorisationCode'] ?? ''), 0, 16), $order]);
    db()->prepare('UPDATE users SET premium_at = COALESCE(premium_at, NOW()) WHERE id = ?')->execute([$row['user_id']]);
} elseif ($row['status'] === 'pending') {
    db()->prepare("UPDATE orders SET status = 'failed' WHERE order_id = ?")->execute([$order]);
}

json_out(200, ['ok' => true]);
