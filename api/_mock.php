<?php
// Temporal para pruebas: imita la API de pagos de Mollie.
declare(strict_types=1);
header('Content-Type: application/json');
if (($_SERVER['HTTP_AUTHORIZATION'] ?? '') !== 'Bearer test_mock') { http_response_code(401); echo '{}'; exit; }
$p = (string)($_GET['p'] ?? '');
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $p === '/payments') {
    $body = json_decode((string)file_get_contents('php://input'), true);
    $id = 'tr_' . bin2hex(random_bytes(5));
    $pay = ['id' => $id, 'status' => 'open', 'amount' => $body['amount'], 'metadata' => $body['metadata'],
            'redirectUrl' => $body['redirectUrl'], 'webhookUrl' => $body['webhookUrl'],
            '_links' => ['checkout' => ['href' => 'https://gba.cooryc.com/?mockpay=' . $id]]];
    file_put_contents(sys_get_temp_dir() . '/gbamock_' . $id, json_encode($pay));
    http_response_code(201); echo json_encode($pay); exit;
}
if (preg_match('#^/payments/(tr_\w+)$#', $p, $m) && is_file($f = sys_get_temp_dir() . '/gbamock_' . $m[1])) {
    echo file_get_contents($f); exit;
}
http_response_code(404); echo '{}';
