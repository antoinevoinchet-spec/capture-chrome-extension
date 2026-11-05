# Capture

Extension Chrome qui capture une page web entière en haute résolution et la découpe en images nettes, puis permet de l'annoter ou de l'exporter. Elle convertit aussi des images. Pas de serveur, pas de compte.

*In English: a Chrome extension that captures a full web page in high resolution, splits it into sharp images, and lets you annotate or export them. It also converts images, with no server and no account. The interface is in French.*

![Page de résultats : une capture découpée en 3 images, avec le choix du découpage et du format](docs/images/resultats.png)

## Ce qu'elle fait

- **Capturer** : la page entière, la partie visible, un bloc (même plus haut que l'écran) ou une zone tracée à la souris. Raccourcis : `Alt+Shift+F`, `Alt+Shift+V`, `Alt+Shift+Z`.
- **Voir une page sur trois écrans** : téléphone, tablette et ordinateur en une seule action, dans un onglet à part.
- **Découper et exporter** : quatre longueurs de découpage, en PNG, JPG ou WebP, avec export en un seul PDF ou un seul zip.
- **Annoter** : flèche, rectangle, surligneur, texte, pastille numérotée, masquage, crayon libre et recadrage. L'original reste intact. Une zone masquée devient une mosaïque dont aucun pixel ne dépend du contenu caché : seules sa taille et sa place restent visibles.
- **Convertir des images** : HEIC, PNG, JPG, WebP, AVIF, GIF et BMP en entrée ; JPG, PNG, WebP ou un PDF unique en sortie. Les images se déposent ou se collent.
- **Enregistrer une image d'un site** : clic droit, puis PNG ou JPG.

| Fenêtre de l'extension | Éditeur d'annotation |
|---|---|
| ![Fenêtre de l'extension](docs/images/fenetre.png) | ![Éditeur d'annotation avec une flèche, un cadre et une zone masquée](docs/images/editeur.png) |

## Mon rôle

J'ai construit cette extension avec Claude Code. J'ai fixé ce qu'elle devait faire, à partir de mes besoins et de ses propositions, tranché les choix qui engagent le produit (permissions, accès aux sites, périmètre) et validé chaque lot par un essai réel avant de passer au suivant. La méthode est décrite dans [`docs/methode.md`](docs/methode.md).

## Installer

L'extension n'est pas sur le Chrome Web Store.

1. Télécharger ce dépôt.
2. Ouvrir `chrome://extensions` et activer le mode développeur.
3. Cliquer sur « Charger l'extension non empaquetée » et choisir le dossier `extension/`.

## Permissions

| Permission | Pourquoi |
|---|---|
| `activeTab`, `scripting` | Lire et capturer la page en cours, au moment où on le demande |
| `downloads` | Enregistrer les fichiers produits |
| `storage` | Garder l'état d'une capture en cours et les réglages |
| `contextMenus`, `offscreen` | Proposer et traiter le clic droit sur une image |
| `debugger` | Simuler un téléphone ou une tablette. Non facultative : Chrome l'annonce comme un accès à toutes les données de tous les sites. L'extension ne s'attache qu'à son onglet temporaire, et Chrome affiche un bandeau pendant la capture |
| Accès à tous les sites (facultatif) | Récupérer une image au clic droit. Chrome le demande à la première utilisation, et il reste accordé jusqu'à son retrait |

Les captures restent dans le navigateur : rien n'est envoyé à un serveur de l'extension, qui n'en a pas. Elle ne fait appel à un site que pour récupérer l'image choisie au clic droit, avec les cookies du navigateur, et pour recharger la page une fois par appareil dans un onglet temporaire. Le défilement pendant une capture déclenche aussi les chargements habituels de la page.

## Limites

- L'interface est en français. L'extension et ses tests ont été éprouvés sur macOS.
- Une capture s'arrête à 100 000 points de haut. Les pages internes de Chrome et le Chrome Web Store ne se capturent pas.
- À un zoom de 110 %, « Page entière » pourrait laisser des lignes vides entre les tranches : c'est un calcul, non vérifié sur une vraie image.
- Un bloc situé dans une autre zone qui défile, ou fixe et plus haut que l'écran, n'est capturé que pour sa partie visible. Plus large que la fenêtre, il est coupé. Le résultat le signale.
- Le mode trois écrans est une émulation de Chrome, pas un vrai appareil. La page y repart de son état initial, et la capture s'arrête si une autre extension insère une iframe dans la page.
- Le clic droit ne gère ni les images en fond CSS, ni les SVG. Certains sites peuvent refuser l'image. Une image animée devient fixe.
- L'export PDF compresse les images en JPEG. Le zip en PNG garde tout.
- Les tests HEIC utilisent des échantillons fabriqués et un fond d'écran fourni par macOS, pas une vraie photo prise avec un téléphone.

## Tests

8 suites Playwright, 758 vérifications au 04/11/2026 sur le dépôt de travail, dont des contrôles pixel par pixel des images produites. Le détail, et ce qui a été relancé sur cette copie, est dans [`docs/methode.md`](docs/methode.md). Elles demandent macOS, poppler (`pdfinfo`, `pdftoppm`), `unzip`, Python et un clone git avec ses étiquettes. Elles se lancent une par une :

```bash
cd tests
pnpm install
pnpm exec playwright install chromium
node convert.mjs /tmp/capture-tests
```

Les autres suites sont `e2e.mjs`, `annotate.mjs`, `lot1.mjs` à `lot4.mjs` et `e2e-2026-10-31-etape1-validee.mjs`. Cette dernière rejoue sur le code actuel les contrôles de la première étape. Le dossier `extension-2026-10-31-etape1-validee/` en est seulement une copie conservée.

## Historique

Cet historique est une version nettoyée du dépôt de travail, resté privé. Les jours des commits sont conservés, pas leurs heures. Les documents de travail et les commits qui ne portaient que sur eux sont retirés, et certains commentaires sont reformulés.

## Licences

Aucune licence n'est accordée pour ce code : il est visible, mais sa réutilisation demande mon accord. Les bibliothèques embarquées gardent la leur, dans `extension/vendor/` :

- [Konva](https://github.com/konvajs/konva) 10.3.0 (MIT) ;
- [heic-to](https://github.com/hoppergee/heic-to) 1.6.7 (LGPL-3.0, avec libheif et libde265). Elle est copiée sans modification, avec le texte de la LGPL et celui de la GPL-3.0.
