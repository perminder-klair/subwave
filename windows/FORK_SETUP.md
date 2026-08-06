# Создание настоящего GitHub-форка

Автоматический вариант: запусти `PUBLISH FORK TO GITHUB.cmd`. Скрипт установит Git/GitHub CLI через winget при необходимости, откроет вход в GitHub, создаст форк, добавит папку `windows`, создаст ветку `windows-edition` и отправит её в твой репозиторий.

Ручной вариант:

```powershell
gh auth login
gh repo fork perminder-klair/subwave --clone --remote
cd subwave
git checkout -b windows-edition
# скопируй содержимое этого пакета в папку windows
git add windows
git commit -m "feat(windows): add Windows installer and manager"
git push -u origin windows-edition
```

GitHub не позволяет создать форк от чужого имени без авторизации в аккаунте, поэтому финальная публикация выполняется локально через `gh auth login`.
