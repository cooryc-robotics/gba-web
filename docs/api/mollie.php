<?php
/* mollie.php — aviso de Mollie cuando cambia un pago (lo llama el servidor
 * de Mollie con id=tr_…). El estado se consulta a la API de Mollie, así que
 * un aviso falso no puede activar ninguna cuenta. */

declare(strict_types=1);
require __DIR__ . '/lib.php';
require __DIR__ . '/mollie-lib.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'Método no permitido');

$id = (string)($_POST['id'] ?? '');
if (!preg_match('/^tr_[A-Za-z0-9]{4,40}$/', $id)) fail(400, 'Pago no válido');

$st = db()->prepare('SELECT * FROM orders WHERE provider_ref = ?');
$st->execute([$id]);
$order = $st->fetch();
// Mollie pide responder 200 también a ids desconocidos.
if ($order) mollie_sync_order($order);

json_out(200, ['ok' => true]);
