# Mechkawaii Production (GitHub Pages)

Petite application web statique pour :
- suivre le stock des pièces 3D,
- générer un plan d'impression prioritaire pour maintenir un tampon de 5 boîtes,
- valider une impression (bouton **Imprimé** → ajoute au stock),
- ajuster le stock (+/- / quantité libre) avec raison,
- assembler une boîte (bouton **Boîte assemblée** → décrémente toutes les pièces selon `perBox`),
- exporter / importer l'état (backup, changement d'ordinateur).

## Déploiement GitHub Pages
1. Crée un repo GitHub (ex: `mechkawaii-production`)
2. Mets ces fichiers à la racine du repo
3. GitHub → Settings → Pages → Deploy from branch → `main` / root
4. Ouvre l'URL fournie par GitHub Pages

## Données
- `data/items.json` contient ta liste de pièces (export de ton CSV).
- Le stock et l'historique sont ensuite stockés localement dans ton navigateur.

## Modifier la liste de pièces
Remplace `data/items.json` (mêmes champs : id, name, perBox, perPlate, stock).
