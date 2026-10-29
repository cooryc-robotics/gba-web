<?php
/* setup.php — configuración inicial, se usa una sola vez.
 *
 * Recibe las credenciales de MySQL (con un token cuyo hash está aquí), crea
 * las tablas y escribe la configuración fuera de la web. Si la configuración
 * ya existe no hace nada. Después de usarlo se borra del repositorio.
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

const SETUP_TOKEN_SHA256 = '9a0c2257983a44c2de79facf12d6b1d38c2d9fbb8b1556f8931ae62df931bad3';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'Método no permitido');
if (is_file(CONFIG_FILE)) fail(403, 'Ya configurado');

$in = read_json();
if (!hash_equals(SETUP_TOKEN_SHA256, hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'Token no válido');

$cfg = [
    'db_name' => (string)($in['db_name'] ?? ''),
    'db_user' => (string)($in['db_user'] ?? ''),
    'db_pass' => (string)($in['db_pass'] ?? ''),
];

$pdo = new PDO(
    'mysql:host=127.0.0.1;port=3306;dbname=' . $cfg['db_name'] . ';charset=utf8mb4',
    $cfg['db_user'], $cfg['db_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$pdo->exec('CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(32) NOT NULL UNIQUE,
    pass_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

$pdo->exec('CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

$pdo->exec('CREATE TABLE IF NOT EXISTS saves (
    user_id INT UNSIGNED NOT NULL,
    save_key VARCHAR(255) NOT NULL,
    data MEDIUMBLOB NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, save_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

$pdo->exec('CREATE TABLE IF NOT EXISTS login_fails (
    ip VARCHAR(45) NOT NULL,
    at DATETIME NOT NULL,
    INDEX (ip, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

$dir = dirname(CONFIG_FILE);
if (!is_dir($dir) && !mkdir($dir, 0700, true)) fail(500, 'No se pudo crear ' . $dir);
$php = "<?php\nreturn " . var_export($cfg, true) . ";\n";
if (file_put_contents(CONFIG_FILE, $php, LOCK_EX) === false) fail(500, 'No se pudo escribir la configuración');
chmod(CONFIG_FILE, 0600);

json_out(200, ['ok' => true]);
