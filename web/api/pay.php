<?php
/* pay.php — pago único de la cuenta premium con Mollie, la pasarela de los
 * enlaces de pago de Qonto (el dinero llega a la cuenta de Qonto).
 *
 *   POST pay.php   → { url }   página de pago de Mollie a la que ir
 *   GET  pay.php   → { status: none|pending|paid|failed, premium }
 *                    consulta el último pedido (al volver de la pasarela)
 *
 * Mollie avisa además a mollie.php cuando cambia el estado del pago.
 *
 * Configuración (en gba-private/config.php):
 *   'mollie'      => ['key' => 'live_…'],   // o 'test_…' para pruebas
 *   'price_cents' => 499,
 *   'site_url'    => 'https://gba.cooryc.com',
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/mollie-lib.php';

$user = require_user();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $st = db()->prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1');
    $st->execute([$user['id']]);
    $order = $st->fetch();
    $status = $order ? mollie_sync_order($order) : 'none';
    json_out(200, ['status' => $status, 'premium' => $user['premium'] || $status === 'paid']);
}

require_post();
if ($user['premium']) fail(409, 'Tu cuenta ya es premium');
if (!mollie_config()) fail(503, 'Los pagos aún no están configurados');

$cfg = config();
$price = (int)($cfg['price_cents'] ?? 499);
$site = rtrim((string)($cfg['site_url'] ?? 'https://gba.cooryc.com'), '/');

$order = bin2hex(random_bytes(6));
db()->prepare('INSERT INTO orders (order_id, user_id, amount_cents, status, created_at) VALUES (?, ?, ?, ?, NOW())')
    ->execute([$order, $user['id'], $price, 'pending']);

$payment = mollie_request('POST', '/payments', [
    'amount' => ['currency' => 'EUR', 'value' => sprintf('%.2f', $price / 100)],
    'description' => 'Game Boy Web Premium (' . $user['username'] . ')',
    'redirectUrl' => $site . '/?pago=' . $order,
    'webhookUrl' => $site . '/api/mollie.php',
    'locale' => 'es_ES',
    'metadata' => ['order_id' => $order, 'user_id' => $user['id']],
]);

$url = $payment['_links']['checkout']['href'] ?? '';
if (empty($payment['id']) || !$url) fail(502, 'La pasarela de pago no responde');
db()->prepare('UPDATE orders SET provider_ref = ? WHERE order_id = ?')->execute([$payment['id'], $order]);

json_out(200, ['url' => $url]);
