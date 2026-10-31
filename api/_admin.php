<?php
// Temporal: consulta los límites del servidor. Se borra después. Protegido con token.
declare(strict_types=1);
require __DIR__ . '/lib.php';
$in = read_json();
if (!hash_equals('595b2b0413edd548854bb9eb1ce91cc10df0ff34ea54f766fa735aaaf1f1f0c0', hash('sha256', (string)($in['token'] ?? '')))) fail(403, 'no');
$out = [];
foreach (['post_max_size','upload_max_filesize','memory_limit','max_execution_time','max_input_time'] as $k) $out[$k] = ini_get($k);
$out['php'] = PHP_VERSION;
$out['disk_free_gb'] = round((float)disk_free_space(__DIR__) / 1e9, 1);
$out['max_allowed_packet'] = db()->query("SELECT @@max_allowed_packet")->fetchColumn();
$out['private_dir_writable'] = is_writable(dirname(CONFIG_FILE));
json_out(200, $out);
