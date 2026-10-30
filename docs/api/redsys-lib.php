<?php
/* redsys-lib.php — firma HMAC_SHA256_V1 de Redsys.
 *
 * La clave de cada operación es el número de pedido cifrado con 3DES (CBC,
 * IV a ceros, relleno con ceros) usando la clave secreta del comercio; la
 * firma es el HMAC-SHA256 de los parámetros en Base64 con esa clave. */

declare(strict_types=1);

function redsys_signature(string $secretB64, string $order, string $paramsB64): string {
    $key = base64_decode($secretB64);
    $padded = str_pad($order, (int)ceil(strlen($order) / 8) * 8, "\0");
    $orderKey = openssl_encrypt($padded, 'des-ede3-cbc', $key, OPENSSL_RAW_DATA | OPENSSL_NO_PADDING, str_repeat("\0", 8));
    return base64_encode(hash_hmac('sha256', $paramsB64, $orderKey, true));
}

// Redsys manda la firma de las notificaciones en Base64 "URL safe".
function redsys_same_signature(string $a, string $b): bool {
    return hash_equals(strtr($a, '-_', '+/'), strtr($b, '-_', '+/'));
}
