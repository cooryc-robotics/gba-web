<?php
/* pay.php — pago único de la cuenta premium con un TPV virtual Redsys
 * (el que dan Santander, CaixaBank, BBVA, Sabadell…).
 *
 *   POST pay.php   → { url, fields: { Ds_SignatureVersion, Ds_MerchantParameters, Ds_Signature } }
 *
 * El navegador envía esos campos en un formulario a `url` (la pasarela de
 * Redsys). Al terminar, Redsys avisa a redsys.php, que activa la cuenta.
 *
 * Configuración (en gba-private/config.php):
 *   'redsys' => [
 *       'merchant' => '123456789',      // Número de comercio (FUC)
 *       'terminal' => '1',
 *       'key'      => '…',              // Clave secreta SHA-256 del comercio
 *       'live'     => false,            // true = cobros reales; false = entorno de pruebas
 *   ],
 *   'price_cents' => 499,
 *   'site_url'    => 'https://gba.cooryc.com',
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/redsys-lib.php';

require_post();
$user = require_user();
if ($user['premium']) fail(409, 'Tu cuenta ya es premium');

$cfg = config();
$rs = $cfg['redsys'] ?? null;
if (!$rs || empty($rs['merchant']) || empty($rs['key'])) fail(503, 'Los pagos aún no están configurados');
$price = (int)($cfg['price_cents'] ?? 499);
$site = rtrim((string)($cfg['site_url'] ?? 'https://gba.cooryc.com'), '/');

// Redsys pide 12 caracteres, los 4 primeros numéricos.
$order = sprintf('%04d', random_int(0, 9999)) . bin2hex(random_bytes(4));
db()->prepare('INSERT INTO orders (order_id, user_id, amount_cents, status, created_at) VALUES (?, ?, ?, ?, NOW())')
    ->execute([$order, $user['id'], $price, 'pending']);

$params = [
    'DS_MERCHANT_AMOUNT' => (string)$price,
    'DS_MERCHANT_ORDER' => $order,
    'DS_MERCHANT_MERCHANTCODE' => (string)$rs['merchant'],
    'DS_MERCHANT_CURRENCY' => '978', // euros
    'DS_MERCHANT_TRANSACTIONTYPE' => '0', // autorización (cobro normal)
    'DS_MERCHANT_TERMINAL' => (string)($rs['terminal'] ?? '1'),
    'DS_MERCHANT_MERCHANTURL' => $site . '/api/redsys.php',
    'DS_MERCHANT_URLOK' => $site . '/?pago=ok',
    'DS_MERCHANT_URLKO' => $site . '/?pago=ko',
    'DS_MERCHANT_PRODUCTDESCRIPTION' => 'Game Boy Web Premium',
    'DS_MERCHANT_TITULAR' => $user['username'],
    'DS_MERCHANT_CONSUMERLANGUAGE' => '001', // español
];
$encoded = base64_encode(json_encode($params));

json_out(200, [
    'url' => !empty($rs['live']) ? 'https://sis.redsys.es/sis/realizarPago' : 'https://sis-t.redsys.es:25443/sis/realizarPago',
    'fields' => [
        'Ds_SignatureVersion' => 'HMAC_SHA256_V1',
        'Ds_MerchantParameters' => $encoded,
        'Ds_Signature' => redsys_signature((string)$rs['key'], $order, $encoded),
    ],
]);
