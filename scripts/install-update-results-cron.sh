#!/usr/bin/env bash
set -euo pipefail

JOB_NAME="wc26-update-results"
CRON_FILE="/etc/cron.d/${JOB_NAME}"
ENV_FILE="/etc/${JOB_NAME}.env"
LOG_FILE="/var/log/${JOB_NAME}.log"
SCHEDULE="17,47 * * * *"
APP_URL=""
CRON_SECRET=""
REMOVE_ONLY="false"

usage() {
  cat <<USAGE
Install or remove the WC26 result updater cron job on Debian.

Usage:
  sudo $0 --url https://your-app.example.com --secret your-cron-secret
  sudo $0 --remove

Options:
  --url       Base URL for the deployed WC26 app, without a trailing slash.
  --secret    Value expected by the app's CRON_SECRET environment variable.
  --remove    Remove the cron job and secret env file.
  --help      Show this help.
USAGE
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this script with sudo." >&2
    exit 1
  fi
}

shell_quote() {
  printf "%q" "$1"
}

install_packages() {
  local packages=()

  if ! command -v curl >/dev/null 2>&1; then
    packages+=("curl")
  fi

  if ! command -v cron >/dev/null 2>&1 && ! command -v crond >/dev/null 2>&1; then
    packages+=("cron")
  fi

  if [[ "${#packages[@]}" -gt 0 ]]; then
    apt-get update
    apt-get install -y ca-certificates "${packages[@]}"
  fi
}

enable_cron_service() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now cron && return
  fi

  service cron start
}

install_job() {
  local normalized_url="${APP_URL%/}"
  local temp_env
  local temp_cron

  temp_env="$(mktemp)"
  temp_cron="$(mktemp)"

  {
    echo "WC26_APP_URL=$(shell_quote "${normalized_url}")"
    echo "WC26_CRON_SECRET=$(shell_quote "${CRON_SECRET}")"
  } >"${temp_env}"

  install_packages
  enable_cron_service

  touch "${LOG_FILE}"
  chown root:adm "${LOG_FILE}" 2>/dev/null || chown root:root "${LOG_FILE}"
  chmod 640 "${LOG_FILE}"

  install -o root -g root -m 600 "${temp_env}" "${ENV_FILE}"
  rm -f "${temp_env}"

  cat >"${temp_cron}" <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

${SCHEDULE} root source ${ENV_FILE} && curl --fail --show-error --silent --request POST --header "Authorization: Bearer \${WC26_CRON_SECRET}" "\${WC26_APP_URL}/api/update-results" >> ${LOG_FILE} 2>&1
CRON

  install -o root -g root -m 644 "${temp_cron}" "${CRON_FILE}"
  rm -f "${temp_cron}"

  echo "Installed ${JOB_NAME}."
  echo "Schedule: ${SCHEDULE}"
  echo "Endpoint: ${normalized_url}/api/update-results"
  echo "Cron file: ${CRON_FILE}"
  echo "Env file: ${ENV_FILE}"
  echo "Log file: ${LOG_FILE}"
}

remove_job() {
  rm -f "${CRON_FILE}" "${ENV_FILE}"
  echo "Removed ${JOB_NAME} cron configuration."
  echo "Log file left in place: ${LOG_FILE}"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --url)
      APP_URL="${2:-}"
      shift 2
      ;;
    --secret)
      CRON_SECRET="${2:-}"
      shift 2
      ;;
    --remove)
      REMOVE_ONLY="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_root

if [[ "${REMOVE_ONLY}" == "true" ]]; then
  remove_job
  exit 0
fi

if [[ -z "${APP_URL}" || -z "${CRON_SECRET}" ]]; then
  usage >&2
  exit 1
fi

install_job
