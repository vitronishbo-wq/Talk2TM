# Instruções do agente para sincronização Git

Quando for necessário resolver automaticamente um fluxo Git divergente no GitHub Codespaces, executar estes comandos sequencialmente a partir da raiz do repositório:

```sh
git config pull.rebase false
git pull origin main --allow-unrelated-histories --no-edit
git push origin main
```

A configuração `pull.rebase false` define explicitamente uma integração por merge. A opção `--allow-unrelated-histories` permite integrar históricos independentes e `--no-edit` aceita a mensagem padrão do merge sem abrir um editor interativo.
