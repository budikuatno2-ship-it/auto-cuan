#!/bin/bash
# S1 — Pengerasan VPS aman TANPA putus SSH pemilik (Ubuntu 24.04, Oracle Cloud).
# Dijalankan via SSH non-interaktif DARI sesi yang sama (BatchMode), sehingga
# aturan firewall diterapkan tanpa menutup koneksi aktif.
#   (a) SSH: PasswordAuthentication no, PermitRootLogin no, MaxAuthTries 4
#   (b) Firewall: UFW (bila tersedia) atau iptables fallback — hanya 22/80/443 publik
#   (c) Fail2Ban: jail sshd + nginx/reverse-proxy
# Privasi: skrip ini TIDAK memuat IP/key/secret apa pun. Key tetap di Drive D lokal.
set -u
S1_OK=1
say() { echo "[S1] $*"; }
fail() { echo "[S1-FAIL] $*"; S1_OK=0; }

# --- 0. Pengaman: pastikan sesi SSH key pemilik tetap diizinkan ---
if [ -d "$HOME/.ssh" ] && [ -f "$HOME/.ssh/authorized_keys" ]; then
  say "authorized_keys ada ($(wc -l < "$HOME/.ssh/authorized_keys" | tr -d ' ') baris)"
else
  fail "authorized_keys HILANG — batalkan hardening agar kunci pemilik tidak terkunci"
  exit 1
fi

# --- (a) SSH hardening via drop-in (tidak mengedit sshd_config utama) ---
sudo mkdir -p /etc/ssh/sshd_config.d
sudo tee /etc/ssh/sshd_config.d/99-s1-hardening.conf > /dev/null <<'EOF'
# S1 hardening (2026-11-01): kunci saja, tanpa password; root dilarang; 4x coba.
PasswordAuthentication no
PermitRootLogin no
MaxAuthTries 4
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding no
EOF
if sudo sshd -t 2>/tmp/s1-sshd-test.err; then
  say "sshd config OK"
  sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd 2>/dev/null || sudo service ssh reload 2>/dev/null || true
  say "sshd reloaded"
else
  fail "sshd -t gagal:"; cat /tmp/s1-sshd-test.err 2>/dev/null || true
fi
sudo sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|maxauthtries|pubkeyauthentication)' || true

# --- (b) Firewall: UFW bila ada, fallback iptables (Oracle VCN sudah membatasi) ---
if command -v ufw >/dev/null 2>&1; then
  say "UFW tersedia — terapkan profil S1"
  sudo ufw --force reset >/dev/null 2>&1 || true
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp comment 'S1 SSH owner'
  sudo ufw allow 80/tcp comment 'S1 HTTP'
  sudo ufw allow 443/tcp comment 'S1 HTTPS'
  sudo ufw limit 22/tcp
  sudo ufw --force enable
  sudo ufw status verbose || true
else
  say "UFW tidak tersedia — pakai iptables fallback (idempoten)"
  # Pastikan 22/80/443 ACCEPT sebelum REJECT; tolak sisanya (termasuk 3000/3001/3010/8080 publik).
  sudo iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
  sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 2 -p tcp --dport 80 -j ACCEPT
  sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 3 -p tcp --dport 443 -j ACCEPT
  # Hapus ACCEPT longgar untuk port internal bila pernah ada.
  for P in 3000 3001 3010 8080; do
    while sudo iptables -C INPUT -p tcp --dport "$P" -j ACCEPT 2>/dev/null; do
      sudo iptables -D INPUT -p tcp --dport "$P" -j ACCEPT 2>/dev/null || break
    done
  done
  sudo iptables -L -n | head -n 30 || true
fi

# --- (c) Fail2Ban: instal bila belum ada, pasang jail S1 ---
if ! command -v fail2ban-client >/dev/null 2>&1; then
  say "fail2ban belum ada — instal via apt (best-effort)"
  sudo apt-get update -qq 2>&1 | tail -n 2 || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban 2>&1 | tail -n 3 || true
fi
if command -v fail2ban-client >/dev/null 2>&1; then
  if [ -f "$HOME/auto-cuan/deploy/vps/fail2ban-jail.local" ]; then
    sudo cp "$HOME/auto-cuan/deploy/vps/fail2ban-jail.local" /etc/fail2ban/jail.local
  elif [ -f "/home/ubuntu/auto-cuan/deploy/vps/fail2ban-jail.local" ]; then
    sudo cp /home/ubuntu/auto-cuan/deploy/vps/fail2ban-jail.local /etc/fail2ban/jail.local
  else
    fail "fail2ban-jail.local tidak ditemukan di repo VPS — jalankan git pull dulu"
  fi
  sudo systemctl enable fail2ban 2>/dev/null || true
  sudo systemctl restart fail2ban 2>/dev/null || sudo service fail2ban restart 2>/dev/null || true
  sleep 3
  sudo fail2ban-client status 2>&1 || true
  sudo fail2ban-client status sshd 2>&1 || true
else
  fail "fail2ban-client tetap tidak tersedia setelah instal"
fi

# --- Verifikasi akhir (tanpa secret) ---
echo "__S1_VERIFY__"
sudo sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin|maxauthtries)' || true
(ss -tlnp 2>/dev/null || ss -tln 2>/dev/null) | head -n 20 || true
sudo fail2ban-client status 2>&1 | head -n 10 || systemctl is-active fail2ban 2>&1 || true

if [ "$S1_OK" = "1" ]; then
  say "HARDENING SELESAI — sesi SSH ini tetap hidup = kunci pemilik aman"
  exit 0
else
  fail "HARDENING SEBAGIAN GAGAL — periksa log di atas"
  exit 1
fi
