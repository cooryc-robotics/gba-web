<?php
/* lib.php — utilidades comunes de la API: configuración, base de datos,
 * respuestas JSON y sesión del usuario.
 *
 * La configuración (credenciales de MySQL) vive fuera de la web, en
 * domains/cooryc.com/gba-private/config.php, y la crea setup.php una sola vez.
 */

declare(strict_types=1);

const CONFIG_FILE = __DIR__ . '/../../../gba-private/config.php';
const SESSION_COOKIE = 'gba_session';
const SESSION_DAYS = 365;
const MAX_SAVE_BYTES = 131072; // mGBA usa un bloque de 128 KiB para cualquier guardado

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function json_out(int $status, array $data): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(int $status, string $msg): void {
    json_out($status, ['error' => $msg]);
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    if (!is_file(CONFIG_FILE)) fail(503, 'El servidor no está configurado');
    $cfg = require CONFIG_FILE;
    $pdo = new PDO(
        'mysql:host=127.0.0.1;port=3306;dbname=' . $cfg['db_name'] . ';charset=utf8mb4',
        $cfg['db_user'],
        $cfg['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    return $pdo;
}

// Las peticiones que cambian datos deben venir de nuestra propia página
// (la cabecera personalizada no la puede poner un formulario de otra web).
function require_post(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'Método no permitido');
    if (($_SERVER['HTTP_X_GBA'] ?? '') !== '1') fail(403, 'Petición no permitida');
}

function read_json(): array {
    $data = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($data) ? $data : [];
}

function client_ip(): string {
    return $_SERVER['REMOTE_ADDR'] ?? '';
}

/* ---- Sesiones: token aleatorio en una cookie, guardado como hash ---- */

function start_session(int $userId): void {
    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ' . SESSION_DAYS . ' DAY))')
        ->execute([hash('sha256', $token), $userId]);
    setcookie(SESSION_COOKIE, $token, [
        'expires' => time() + SESSION_DAYS * 86400,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function end_session(): void {
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if ($token !== '') {
        db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
    }
    setcookie(SESSION_COOKIE, '', ['expires' => 1, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
}

// Devuelve el usuario de la sesión actual o null.
function current_user(): ?array {
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || !preg_match('/^[0-9a-f]{64}$/', $token)) return null;
    $st = db()->prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW()');
    $st->execute([hash('sha256', $token)]);
    $user = $st->fetch();
    return $user ?: null;
}

function require_user(): array {
    $user = current_user();
    if (!$user) fail(401, 'Inicia sesión');
    return $user;
}
