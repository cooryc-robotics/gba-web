<?php
/* mollie-lib.php — pagos con Mollie, la pasarela que usa Qonto para sus
 * enlaces de pago. El dinero se liquida en la cuenta de Qonto.
 *
 * No hace falta comprobar firmas: el aviso de Mollie solo trae el id del
 * pago y el estado real se consulta siempre a la API con nuestra clave. */

declare(strict_types=1);

function mollie_config(): ?array {
    $m = config()['mollie'] ?? null;
    return ($m && !empty($m['key'])) ? $m : null;
}

function mollie_request(string $method, string $path, ?array $body = null): array {
    $m = mollie_config();
    if (!$m) fail(503, 'Los pagos aún no están configurados');
    $base = rtrim((string)($m['api'] ?? 'https://api.mollie.com/v2'), '/');
    $ch = curl_init($base . $path);
    $headers = ['Authorization: Bearer ' . $m['key'], 'Accept: application/json'];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if ($status < 200 || $status >= 300 || !is_array($data)) {
        error_log('Mollie ' . $method . ' ' . $path . ' → ' . $status . ' ' . substr((string)$raw, 0, 300));
        fail(502, 'La pasarela de pago no responde');
    }
    return $data;
}

/* Consulta el pago de un pedido en Mollie y actualiza el pedido y la cuenta.
 * Devuelve el estado del pedido: pending, paid o failed. */
function mollie_sync_order(array $order): string {
    if ($order['status'] !== 'pending' || empty($order['provider_ref'])) return $order['status'];
    $p = mollie_request('GET', '/payments/' . rawurlencode($order['provider_ref']));

    $ok = ($p['status'] ?? '') === 'paid'
        && ($p['amount']['currency'] ?? '') === 'EUR'
        && ($p['amount']['value'] ?? '') === sprintf('%.2f', $order['amount_cents'] / 100)
        && ($p['metadata']['order_id'] ?? '') === $order['order_id'];
    if ($ok) {
        db()->prepare("UPDATE orders SET status = 'paid', paid_at = NOW() WHERE order_id = ? AND status = 'pending'")
            ->execute([$order['order_id']]);
        db()->prepare('UPDATE users SET premium_at = COALESCE(premium_at, NOW()) WHERE id = ?')
            ->execute([$order['user_id']]);
        return 'paid';
    }
    if (in_array($p['status'] ?? '', ['failed', 'canceled', 'expired'], true)) {
        db()->prepare("UPDATE orders SET status = 'failed' WHERE order_id = ? AND status = 'pending'")
            ->execute([$order['order_id']]);
        return 'failed';
    }
    return 'pending';
}
