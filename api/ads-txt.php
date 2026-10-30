<?php
/* ads-txt.php — sirve /ads.txt (lo pide AdSense) con el id de editor de
 * config.php. Sin anuncios configurados, 404. */

declare(strict_types=1);
require __DIR__ . '/lib.php';

$ads = ads_config();
if (!$ads) { http_response_code(404); exit; }
header('Content-Type: text/plain; charset=utf-8');
echo 'google.com, ' . substr($ads['client'], 3) . ", DIRECT, f08c47fec0942fa0\n";
