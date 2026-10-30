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
const FREE_CLOUD_GAMES = 3;    // juegos con partida en la nube en la cuenta gratis
const HISTORY_KEEP = 10;       // versiones anteriores que se guardan por juego (premium)
const HISTORY_MIN_GAP = 120;   // segundos mínimos entre dos versiones del historial
const STATE_SLOTS = 3;         // huecos de estado rápido por juego (premium)
const MAX_STATE_BYTES = 1048576;
const THEMES = ['indigo', 'atomic', 'kiwi', 'coral', 'black', 'gold'];

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

function config(): array {
    static $cfg = null;
    if ($cfg === null) {
        if (!is_file(CONFIG_FILE)) fail(503, 'El servidor no está configurado');
        $cfg = require CONFIG_FILE;
    }
    return $cfg;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $cfg = config();
    $pdo = new PDO(
        'mysql:host=127.0.0.1;port=3306;dbname=' . $cfg['db_name'] . ';charset=utf8mb4',
        $cfg['db_user'],
        $cfg['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    $pdo->exec("SET time_zone = '+00:00'");
    migrate($pdo);
    return $pdo;
}

/* ---- Cambios de esquema ----
 * Cada entrada se aplica una vez, en orden; schema_version guarda la última.
 * La versión 1 son las tablas que creó setup.php. */
function migrate(PDO $pdo): void {
    $steps = [
        2 => [
            'ALTER TABLE users ADD premium_at DATETIME NULL, ADD theme VARCHAR(32) NULL',
            'CREATE TABLE save_history (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                save_key VARCHAR(255) NOT NULL,
                data MEDIUMBLOB NOT NULL,
                saved_at DATETIME NOT NULL,
                INDEX (user_id, save_key, saved_at),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
            'CREATE TABLE states (
                user_id INT UNSIGNED NOT NULL,
                save_key VARCHAR(255) NOT NULL,
                slot TINYINT UNSIGNED NOT NULL,
                data MEDIUMBLOB NOT NULL,
                updated_at DATETIME NOT NULL,
                PRIMARY KEY (user_id, save_key, slot),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
            'CREATE TABLE cheats (
                user_id INT UNSIGNED NOT NULL,
                save_key VARCHAR(255) NOT NULL,
                codes TEXT NOT NULL,
                PRIMARY KEY (user_id, save_key),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
            'CREATE TABLE orders (
                order_id CHAR(12) PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                amount_cents INT UNSIGNED NOT NULL,
                status VARCHAR(16) NOT NULL,
                created_at DATETIME NOT NULL,
                paid_at DATETIME NULL,
                auth_code VARCHAR(16) NULL,
                INDEX (user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
        ],
    ];

    $pdo->exec('CREATE TABLE IF NOT EXISTS schema_version (v INT NOT NULL) ENGINE=InnoDB');
    $v = $pdo->query('SELECT MAX(v) FROM schema_version')->fetchColumn();
    $v = $v === null ? 1 : (int)$v;
    if ($v >= max(array_keys($steps))) return;

    // Bloqueo para que dos peticiones a la vez no apliquen el mismo cambio.
    if (!$pdo->query("SELECT GET_LOCK('gba_migrate', 10)")->fetchColumn()) fail(503, 'Inténtalo de nuevo');
    try {
        $v = (int)($pdo->query('SELECT MAX(v) FROM schema_version')->fetchColumn() ?? 1);
        foreach ($steps as $to => $sqls) {
            if ($to <= $v) continue;
            foreach ($sqls as $sql) $pdo->exec($sql);
            $pdo->prepare('INSERT INTO schema_version (v) VALUES (?)')->execute([$to]);
        }
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('gba_migrate')");
    }
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
    $st = db()->prepare('SELECT u.id, u.username, u.premium_at, u.theme FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW()');
    $st->execute([hash('sha256', $token)]);
    $user = $st->fetch();
    return $user ? public_user($user) : null;
}

// Lo que se envía al navegador sobre el usuario.
function public_user(array $row): array {
    return [
        'id' => (int)$row['id'],
        'username' => $row['username'],
        'premium' => !empty($row['premium_at']),
        'theme' => $row['theme'] ?? null,
    ];
}

function require_user(): array {
    $user = current_user();
    if (!$user) fail(401, 'Inicia sesión');
    return $user;
}

function require_premium(): array {
    $user = require_user();
    if (!$user['premium']) fail(402, 'Función premium');
    return $user;
}

// Clave de juego que llega en ?key= (nombre del ROM + '::' + tamaño).
function game_key(): string {
    $key = $_GET['key'] ?? '';
    if (!is_string($key) || $key === '' || strlen($key) > 255) fail(400, 'Clave no válida');
    return $key;
}
