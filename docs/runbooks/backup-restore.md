# Backup e restauração do PicaShorts

O backup de produção inclui o dump compactado do PostgreSQL e um espelho do bucket MinIO em `/srv/clipbr/backups/<UTC-STAMP>/minio`. O script também registra um hash do arquivo de ambiente; o conteúdo do ambiente só é cifrado quando `VPS_BACKUP_GPG_RECIPIENT` estiver configurado.

## Executar e verificar

```bash
sudo -iu clipbr
cd /srv/clipbr/app
ENV_FILE=/srv/clipbr/app/.env.production scripts/vps/backup.sh
gzip -t /srv/clipbr/backups/<UTC-STAMP>/postgres.sql.gz
find /srv/clipbr/backups/<UTC-STAMP>/minio -type f | head
```

O job deve ser executado diariamente por cron/systemd, mantendo pelo menos 35 dias. Após cada execução, valide `gzip -t`, a existência do espelho MinIO e o tamanho do dump; uma vez por mês faça um restore em uma stack isolada.

## Restore controlado

O restore do banco interrompe conexões e substitui o banco informado. Faça uma janela de manutenção e confirme explicitamente:

```bash
CONFIRM_RESTORE=I_UNDERSTAND_DATA_WILL_BE_REPLACED \
  ENV_FILE=/srv/clipbr/app/.env.production \
  scripts/vps/restore-backup.sh <UTC-STAMP>
```

Depois valide `/health/ready`, `/health/pipeline`, contagem de usuários/vídeos e um download de export. O conteúdo MinIO deve ser espelhado para uma área temporária e conferido por hash antes de substituir objetos ativos.
