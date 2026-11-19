# Méthode de travail

Le projet a été mené avec Claude Code. Depuis l'éditeur d'annotation, chaque chantier a des documents écrits avant le code, et le dernier est découpé en lots. Cette page décrit la méthode. Les documents de travail eux-mêmes (conceptions, plans, journal) ne sont pas publiés ici.

## Qui fait quoi

Le porteur du projet fixe ce que le produit doit faire, à partir de ses besoins et des propositions de Claude Code, tranche les choix qui engagent le produit et valide chaque lot par un essai réel avant que le suivant commence. À partir de ce cadre, Claude Code produit les conceptions, les plans, le code et les tests, lance les suites et tient le journal. Fusionner, pousser ou supprimer une branche demande l'accord du porteur du projet.

## Une conception avant le code

Cinq documents de conception existent : l'éditeur d'annotation, le convertisseur, les six ajouts réunis, la transcription YouTube et le design system. Ils suivent la même trame, dans cet ordre :

- **Intention** : ce que la fonctionnalité apporte.
- **Objectifs** : ce qui doit marcher (sauf dans le document des ajouts, qui part de l'intention).
- **Non-objectifs** : ce qu'on ne fait pas dans cette version. Un non-objectif peut être levé plus tard, avec une ligne datée dans le document concerné.
- **Anti-objectifs** : ce qui est un échec même si tout marche. Exemple : un texte masqué qu'on peut deviner ou récupérer dans le fichier exporté. Autre exemple : un fichier exporté qui contient encore les zones recadrées.
- **Contraintes**, par exemple : aucun code chargé depuis internet, une seule grande image en mémoire à la fois.
- **Exigences** numérotées D1, D2, D3, chacune suivie d'une ligne « Vérifiable par : » qui nomme le test, la commande ou le comportement observable qui la prouve.
- **Choix techniques**, avec les options écartées et la raison.
- Selon le document, **risques**, **limites connues**, **questions** en attente et **sources**.

Exemple d'exigence avec sa preuve (D8, masquage irréversible). Dans le fichier exporté, la zone masquée devient une mosaïque de gros blocs unis, dont les couleurs ne dépendent pas du contenu caché. Vérifiable par : un test masque deux zones de même entourage contenant des textes différents, exporte en PNG, vérifie que chaque bloc est d'une seule couleur et que les deux zones masquées sont identiques pixel à pixel. La conception note cette révision, datée du 31/10/2026 : le masquage garde l'aspect d'une pixelisation en gros blocs, mais ses couleurs ne viennent pas du contenu caché, car une pixelisation classique se déchiffre parfois.

## Un plan découpé en lots

Les ajouts à l'extension sont livrés en quatre lots, de la version 0.2.0 à la version 0.5.0. Un seul plan les couvre. Chaque tâche du plan porte une ligne « Couvre : D… » qui la relie aux exigences, la liste des fichiers touchés et les étapes : écrire le test, le voir échouer, écrire le code, le voir réussir, committer, cocher la case.

Chaque lot se fait dans une session Claude Code neuve, sans mémoire des précédentes. Trois fichiers portent la mémoire : la conception, le plan et le journal. Le brief de session fixe le périmètre (quels dossiers, quelles tâches), les actions permises sans demander, les critères de fin sous forme de cases et la règle de preuve : on n'écrit « fait » qu'avec la commande lancée et son résultat.

Le dernier lot commence par un essai. Il mesure des critères d'arrêt fixés à l'avance. Si un seul est atteint, le lot s'arrête et la permission demandée est retirée. Dans l'essai réalisé, aucun critère n'a été atteint et le lot a continué.

La transcription YouTube (version 0.6.0) a son propre plan. Il commence lui aussi par un essai : trois façons de lire le texte d'une vidéo, mesurées sur onze vidéos, d'abord dans un Chromium de test, puis sur le Chrome connecté du porteur du projet. L'essai relève aussi les effets sur son compte YouTube : historique, position de reprise, langue de sous-titres retenue. La façon retenue est la plus sûre de celles qui changent de langue, une autre sert de secours, et la troisième n'a pas été construite. Pour deux tâches de ce plan, le code a été écrit avant ses tests ; le journal le note.

Le design system (version 0.7.0) a aussi son plan. Il part de trois relectures neutres des écrans (ergonomie, cohérence visuelle, accessibilité) et des six changements de comportement qu'elles ont fait retenir. Les couleurs sont écrites en deux couches, des gammes de gris chaud et de terre cuite puis des rôles (fond, texte, accent, focus, danger), et chaque contraste de rôle est vérifié par un test, en clair et en sombre. Un audit axe tourne sur chaque écran dans les deux modes : une couleur qu'axe ne sait pas lire fait échouer le test au lieu de passer en silence. Des contrôles statiques refusent toute couleur ou taille écrite en dur dans les écrans, sauf sur une ligne commentée qui dit pourquoi. Après chaque écran refait, toutes les suites existantes qui le touchent ont été relancées, pas seulement celle de l'écran : c'est ce qui a montré qu'une phrase d'aide avait disparu d'un autre écran. Les photos ont aussi trouvé ce que les tests ne voyaient pas, comme des libellés coupés d'un pixel ; un test a été ajouté à chaque fois.

## Comment un lot se termine

1. La suite de tests du lot est lancée, puis les suites existantes, une par une, avec les nombres réels.
2. Les promesses modifiées volontairement sont notées d'une ligne datée dans les anciens documents.
3. Le journal est mis à jour : état, décisions, pièges, commandes, résultats.
4. Un relecteur neuf, en lecture seule, reçoit la demande d'origine, la conception, les exigences du lot, le journal et les commits. Il ne reçoit pas le raisonnement de la session. Il ne lance rien et ne rend que les écarts qui changent le résultat. Chaque écart est vérifié, puis corrigé, ou nommé comme non retenu ou resté ouvert. Le verdict est écrit dans le journal. Il a rendu « à refaire » cinq fois : deux passages au lot 3, deux au lot 4, un à la transcription. Pour le design system, il a rendu « prêt » avec quatre écarts, dont trois corrigés et un laissé ouvert, puis un second évaluateur a comparé le code à la conception. Pour la transcription, un modèle d'une autre famille a aussi relu le code ; les deux relectures ont relevé dix écarts, tous corrigés avec un test.
5. Un essai réel est demandé : d'abord recharger l'extension et lire sa version, pour être sûr de tester le nouveau code, puis quelques gestes qui disent ce qu'ils débloquent et ce qu'on doit voir.
6. L'étiquette `lotN-valide` n'est posée qu'après cet essai réussi. La session s'arrête là.

## Comment les choix sont consignés

- Chaque choix technique garde les options écartées et la raison. Un choix pris par Claude Code sans réponse humaine est marqué « choix de Claude », pour être relu.
- Les questions de fond sont posées en A ou B, recommandation d'abord. La réponse est écrite avec sa date dans le plan et dans le journal. Par exemple, la demande d'un accès à tous les sites pour le clic droit a été posée avec son risque, puis tranchée.
- Quand un essai change une tâche, le plan est corrigé avant de coder et la raison est écrite dans le journal.
- Une confirmation humaine est notée pour ce qu'elle couvre, sans détail inventé.

## Comment les limites sont écrites

- Les conceptions du convertisseur et des ajouts ont une section « Limites connues » : par exemple, le PDF est en JPEG avec perte, et l'interface le dit dans son menu.
- La conception des ajouts classe ses sources : documents du projet lus en entier, documentation officielle de Chrome lue en résumé, extraits de recherche à la fiabilité moindre, faits de mémoire non vérifiés, et ce qui n'a pas été lu. Un fait venu de la mémoire est étiqueté comme tel.
- Le journal a une rubrique « Non vérifiable » à chaque lot, par exemple le vrai menu natif du navigateur ou la vraie invite de permission, qu'un test automatique ne sait pas piloter.
- Une mesure dit ce qu'elle ne mesure pas. Exemple : la mémoire relevée ne compte pas ce que le système a compressé, donc le chiffre réel peut être plus haut.
- Un écart resté ouvert est nommé, avec la raison pour laquelle il est accepté.

## Ce que vérifient les tests

Les tests pilotent un vrai navigateur. Ils vérifient :

- des pixels : une couleur attendue à un endroit attendu dans l'image exportée ;
- des octets : le type réel d'un fichier, sa fin exacte, l'absence de métadonnées ;
- des fichiers lus par des outils indépendants du code (`pdfinfo`, `pdftoppm`, `unzip -t`) ;
- l'original intact : empreintes des données avant et après une modification ;
- la durée et la mémoire sur une page de 100 000 points de haut, avec un seuil de 2,5 Go ;
- le clavier, les modes clair et sombre, la liste exacte des permissions, l'absence de requête réseau pendant une conversion.

Un test écrit avec son correctif est rejoué sur l'ancien code. Le journal note que 2 tests sur 5 passaient à tort la première fois. Les tests qui prouvaient moins que leur nom ont été renforcés après relecture.

## Dernier relevé

Fin du design system, le 19/11/2026, sur cette copie publique. Les dix suites ont été lancées l'une après l'autre, avec le code de sortie 0 chacune : design system 139/139, lot 4 98/98, convertisseur 96/96, éditeur d'annotation 128/128, capture 116/116, étape 1 42/42, lot 1 100/100 (dont l'export de 100 000 points, lancé seul), lot 2 83/83, lot 3 95/95, transcription 108/108. Les mêmes nombres ont été obtenus la veille sur le dépôt de travail.

Reste non prouvé par un test : le rendu sur un vrai Chrome, que le porteur du projet a vérifié à la main (panneau, capture annotée et téléchargée, conversion, transcription, mode sombre), et l'effet sur le compte YouTube le lendemain d'une transcription.

Cette copie publique diffère du dépôt de travail par des textes d'interface et des commentaires, et par l'adresse du groupe `site` de `lot4.mjs`, qui doit être fournie.
