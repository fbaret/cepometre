<?php
// Réglage de l'alerte perso du Cèpomètre : position + rayon + mail.
// Écrit par l'appli déverrouillée (jeton connu d'elle seule), relu par GitHub. Stocké chiffré, jamais servi tel quel.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$HASH = '__TOKEN_HASH__';
$tok = $_SERVER['HTTP_X_TOKEN'] ?? '';
if (!$tok || !hash_equals($HASH, hash('sha256', $tok))) { http_response_code(403); echo '{"error":"jeton"}'; exit; }
$dir = __DIR__ . '/data';
$file = $dir . '/alerte.bin';
$key = hash('sha256', $tok . ':stockage', true);
function lire($file, $key) {
  if (!is_file($file)) return null;
  $raw = file_get_contents($file); $iv = substr($raw, 0, 16);
  $js = openssl_decrypt(substr($raw, 16), 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
  return $js ? json_decode($js, true) : null;
}
$m = $_SERVER['REQUEST_METHOD'];
if ($m === 'GET') { echo json_encode(lire($file, $key) ?: new stdClass()); exit; }
if ($m === 'DELETE') { @unlink($file); echo '{"ok":true}'; exit; }
if ($m !== 'POST') { http_response_code(405); exit; }
$in = json_decode(file_get_contents('php://input'), true) ?: [];
$lat = floatval($in['lat'] ?? 0); $lon = floatval($in['lon'] ?? 0); $r = intval($in['rayon'] ?? 20);
$mail = trim($in['email'] ?? '');
if ($lat < 41 || $lat > 45 || $lon < -3 || $lon > 3 || $r < 5 || $r > 80 || ($mail !== '' && !filter_var($mail, FILTER_VALIDATE_EMAIL))) {
  http_response_code(400); echo '{"error":"valeurs"}'; exit;
}
if (!is_dir($dir)) { mkdir($dir, 0700, true); file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n"); }
$data = ['lat' => round($lat, 4), 'lon' => round($lon, 4), 'rayon' => $r, 'email' => $mail, 'maj' => gmdate('c')];
$iv = random_bytes(16);
file_put_contents($file, $iv . openssl_encrypt(json_encode($data), 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv), LOCK_EX);
echo json_encode(['ok' => true] + $data);
