// La carte du labyrinthe (1 = mur, 0 = vide, 2 = sortie)
const map = [
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 2, 1], // La sortie se trouve ici (2)
    [1, 0, 1, 1, 0, 1, 0, 1],
    [1, 0, 1, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 1, 1, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1]
];

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// Position et orientation de départ du joueur
let player = {
    x: 1.5,
    y: 1.5,
    dirX: -1,
    dirY: 0,
    planeX: 0,
    planeY: 0.66
};

// Fonction principale pour dessiner la vue 3D
function gameLoop() {
    // Effacer l'écran
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Lancer de rayons (Raycasting) pour chaque pixel de l'écran en largeur
    for (let x = 0; x < canvas.width; x++) {
        let cameraX = 2 * x / canvas.width - 1;
        let rayDirX = player.dirX + player.planeX * cameraX;
        let rayDirY = player.dirY + player.planeY * cameraX;

        let mapX = Math.floor(player.x);
        let mapY = Math.floor(player.y);

        let sideDistX;
        let sideDistY;

        let deltaDistX = Math.abs(1 / rayDirX);
        let deltaDistY = Math.abs(1 / rayDirY);
        let perpWallDist;

        let stepX, stepY;
        let hit = 0;
        let side;

        if (rayDirX < 0) {
            stepX = -1;
            sideDistX = (player.x - mapX) * deltaDistX;
        } else {
            stepX = 1;
            sideDistX = (mapX + 1.0 - player.x) * deltaDistX;
        }

        if (rayDirY < 0) {
            stepY = -1;
            sideDistY = (player.y - mapY) * deltaDistY;
        } else {
            stepY = 1;
            sideDistY = (mapY + 1.0 - player.y) * deltaDistY;
        }

        // Boucle pour avancer le rayon jusqu'à toucher un mur (1) ou la sortie (2)
        while (hit === 0) {
            if (sideDistX < sideDistY) {
                sideDistX += deltaDistX;
                mapX += stepX;
                side = 0;
            } else {
                sideDistY += deltaDistY;
                mapY += stepY;
                side = 1;
            }
            if (map[mapY][mapX] > 0) hit = 1;
        }

        if (side === 0) perpWallDist = (mapX - player.x + (1 - stepX) / 2) / rayDirX;
        else perpWallDist = (mapY - player.y + (1 - stepY) / 2) / rayDirY;

        let lineHeight = Math.floor(canvas.height / perpWallDist);

        let drawStart = -lineHeight / 2 + canvas.height / 2;
        if (drawStart < 0) drawStart = 0;
        let drawEnd = lineHeight / 2 + canvas.height / 2;
        if (drawEnd >= canvas.height) drawEnd = canvas.height - 1;

        // Si on touche la sortie (2), on affiche un mur d'une couleur différente (ex: vert)
        let isExit = (map[mapY][mapX] === 2);
        if (isExit) {
            ctx.strokeStyle = "#2ecc71"; // Vert pour la sortie
        } else {
            ctx.strokeStyle = side === 1 ? "#888" : "#cc2222";
        }

        ctx.beginPath();
        ctx.moveTo(x, drawStart);
        ctx.lineTo(x, drawEnd);
        ctx.stroke();
    }
}

// Vérifie si le joueur a atteint la sortie
function checkWinCondition() {
    let currentX = Math.floor(player.x);
    let currentY = Math.floor(player.y);

    if (map[currentY][currentX] === 2) {
        setTimeout(() => {
            let playAgain = confirm("🎉 Bravo ! Tu as trouvé la sortie !\nVeux-tu rejouer ?");
            if (playAgain) {
                // Remettre le joueur au point de départ
                player.x = 1.5;
                player.y = 1.5;
                player.dirX = -1;
                player.dirY = 0;
                player.planeX = 0;
                player.planeY = 0.66;
                gameLoop();
            } else {
                alert("Merci d'avoir joué ! À bientôt.");
            }
        }, 100);
    }
}

// Gestion des mouvements (Avancer, Reculer, Tourner)
const moveSpeed = 0.15;
const rotSpeed = 0.1;

function moveForward() {
    let nextX = player.x + player.dirX * moveSpeed;
    let nextY = player.y + player.dirY * moveSpeed;
    
    // Autorise le déplacement si la case cible est vide (0) ou la sortie (2)
    if (map[Math.floor(player.y)][Math.floor(nextX)] !== 1) player.x = nextX;
    if (map[Math.floor(nextY)][Math.floor(player.x)] !== 1) player.y = nextY;

    gameLoop();
    checkWinCondition();
}

function moveBackward() {
    let nextX = player.x - player.dirX * moveSpeed;
    let nextY = player.y - player.dirY * moveSpeed;

    if (map[Math.floor(player.y)][Math.floor(nextX)] !== 1) player.x = nextX;
    if (map[Math.floor(nextY)][Math.floor(player.x)] !== 1) player.y = nextY;

    gameLoop();
    checkWinCondition();
}

function turnLeft() {
    let oldDirX = player.dirX;
    player.dirX = player.dirX * Math.cos(rotSpeed) - player.dirY * Math.sin(rotSpeed);
    player.dirY = oldDirX * Math.sin(rotSpeed) + player.dirY * Math.cos(rotSpeed);
    let oldPlaneX = player.planeX;
    player.planeX = player.planeX * Math.cos(rotSpeed) - player.planeY * Math.sin(rotSpeed);
    player.planeY = oldPlaneX * Math.sin(rotSpeed) + player.planeY * Math.cos(rotSpeed);
    gameLoop();
}

function turnRight() {
    let oldDirX = player.dirX;
    player.dirX = player.dirX * Math.cos(-rotSpeed) - player.dirY * Math.sin(-rotSpeed);
    player.dirY = oldDirX * Math.sin(-rotSpeed) + player.dirY * Math.cos(-rotSpeed);
    let oldPlaneX = player.planeX;
    player.planeX = player.planeX * Math.cos(-rotSpeed) - player.planeY * Math.sin(-rotSpeed);
    player.planeY = oldPlaneX * Math.sin(-rotSpeed) + player.planeY * Math.cos(-rotSpeed);
    gameLoop();
}

// Assigner les boutons tactiles
document.getElementById("btnUp").addEventListener("click", moveForward);
document.getElementById("btnDown").addEventListener("click", moveBackward);
document.getElementById("btnLeft").addEventListener("click", turnLeft);
document.getElementById("btnRight").addEventListener("click", turnRight);

// Enregistrement du Service Worker pour le mode PWA (hors-ligne)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => console.log("Service Worker enregistré avec succès !"))
    .catch((err) => console.log("Erreur Service Worker :", err));
}

// Lancer le premier affichage au démarrage
gameLoop();
