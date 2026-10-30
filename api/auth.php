<?php
/* auth.php — cuentas de usuario.
 *
 *   GET  auth.php                     → { user: {id, username, premium, theme} | null, ads }
 *   POST auth.php?action=register     { username, password }
 *   POST auth.php?action=login        { username, password }
 *   POST auth.php?action=logout
 *   POST auth.php?action=settings     { theme }            (premium)
 *   POST auth.php?action=delete       { password }         borra la cuenta y todo lo suyo
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

const MAX_FAILS = 10;      // intentos fallidos permitidos por IP…
const FAIL_WINDOW_MIN = 15; // …en este número de minutos

$action = $_GET['action'] ?? '';

if ($action === '') {
    json_out(200, ['user' => current_user(), 'ads' => ads_config()]);
}

require_post();

if ($action === 'logout') {
    end_session();
    json_out(200, ['user' => null]);
}

if ($action === 'settings') {
    $user = require_premium();
    $theme = (string)(read_json()['theme'] ?? '');
    if (!in_array($theme, THEMES, true)) fail(400, 'Tema desconocido');
    db()->prepare('UPDATE users SET theme = ? WHERE id = ?')->execute([$theme, $user['id']]);
    json_out(200, ['user' => array_merge($user, ['theme' => $theme])]);
}

// Freno a quien prueba contraseñas a lo bruto.
$st = db()->prepare('SELECT COUNT(*) FROM login_fails WHERE ip = ? AND at > DATE_SUB(NOW(), INTERVAL ' . FAIL_WINDOW_MIN . ' MINUTE)');
$st->execute([client_ip()]);
if ((int)$st->fetchColumn() >= MAX_FAILS) fail(429, 'Demasiados intentos. Prueba dentro de un rato.');

function note_fail(): void {
    db()->prepare('INSERT INTO login_fails (ip, at) VALUES (?, NOW())')->execute([client_ip()]);
    db()->exec('DELETE FROM login_fails WHERE at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
}

$in = read_json();
$password = (string)($in['password'] ?? '');

if ($action === 'delete') {
    $user = require_user();
    $st = db()->prepare('SELECT pass_hash FROM users WHERE id = ?');
    $st->execute([$user['id']]);
    if (!password_verify($password, (string)$st->fetchColumn())) {
        note_fail();
        fail(401, 'Contraseña incorrecta');
    }
    // Las partidas, estados, trucos, sesiones y pedidos se borran en cascada.
    db()->prepare('DELETE FROM users WHERE id = ?')->execute([$user['id']]);
    end_session();
    json_out(200, ['user' => null]);
}

if ($action !== 'login' && $action !== 'register') fail(400, 'Acción desconocida');

$username = trim((string)($in['username'] ?? ''));

if ($action === 'register') {
    if (!preg_match('/^[A-Za-z0-9_.-]{3,32}$/', $username)) {
        fail(400, 'El usuario debe tener de 3 a 32 letras, números, puntos, guiones o guiones bajos');
    }
    if (strlen($password) < 8) fail(400, 'La contraseña debe tener al menos 8 caracteres');
    if (strlen($password) > 200) fail(400, 'La contraseña es demasiado larga');

    try {
        db()->prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, NOW())')
            ->execute([$username, password_hash($password, PASSWORD_DEFAULT)]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') fail(409, 'Ese usuario ya existe');
        throw $e;
    }
    $id = (int)db()->lastInsertId();
    start_session($id);
    json_out(200, ['user' => public_user(['id' => $id, 'username' => $username])]);
}

// login
$st = db()->prepare('SELECT id, username, pass_hash, premium_at, theme FROM users WHERE username = ?');
$st->execute([$username]);
$row = $st->fetch();
if (!$row || !password_verify($password, $row['pass_hash'])) {
    note_fail();
    fail(401, 'Usuario o contraseña incorrectos');
}
if (password_needs_rehash($row['pass_hash'], PASSWORD_DEFAULT)) {
    db()->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')
        ->execute([password_hash($password, PASSWORD_DEFAULT), $row['id']]);
}
start_session((int)$row['id']);
json_out(200, ['user' => public_user($row)]);
