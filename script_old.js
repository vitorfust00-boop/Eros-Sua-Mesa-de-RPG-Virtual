document.addEventListener('DOMContentLoaded', () => {
    // --- Estado Local ---
    let currentUser = { nickname: '', isDM: false };
    
    // --- Estado da Sala ---
    let roomState = { code: '', players: [], logs: [], publicImage: '' };

    // --- Variáveis de Conexão MQTT ---
    let mqttClient = null;
    let isHost = false;
    let myClientId = 'client_' + Math.random().toString(16).substr(2, 8);
    let topicState = '';
    let topicActions = '';

    // --- Elementos DOM ---
    const screens = { login: document.getElementById('login-screen'), room: document.getElementById('room-screen') };
    const nicknameInput = document.getElementById('nickname');
    const roomCodeInput = document.getElementById('room-code-input');
    const btnCreateRoom = document.getElementById('btn-create-room');
    const btnJoinRoom = document.getElementById('btn-join-room');
    const loginError = document.getElementById('login-error');
    
    const displayRoomCode = document.getElementById('display-room-code');
    const displayUserInfo = document.getElementById('user-info');
    const playersList = document.getElementById('players-list');
    const publicDiceLog = document.getElementById('dice-results');
    
    const btnBecomeDM = document.getElementById('btn-become-dm');
    const btnDMScreen = document.getElementById('btn-dm-screen');
    const dmModal = document.getElementById('dm-modal');
    const btnCloseDM = document.getElementById('btn-close-dm');
    const mainImage = document.getElementById('main-image');
    const noImageText = document.getElementById('no-image-text');

    // --- Funções Auxiliares ---
    function switchScreen(screenName) {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        screens[screenName].classList.add('active');
    }

    function generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for(let i=0; i<5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        return code;
    }

    // --- Renderização da Sala ---
    function renderRoom() {
        displayRoomCode.textContent = roomState.code;
        displayUserInfo.innerHTML = `Logado como: <strong>${currentUser.nickname}</strong>`;

        playersList.innerHTML = '';
        roomState.players.forEach(player => {
            const li = document.createElement('li');
            li.textContent = player.name;
            if (player.isDM) {
                const badge = document.createElement('span');
                badge.className = 'dm-badge';
                badge.textContent = 'MESTRE';
                li.appendChild(badge);
                if(player.name === currentUser.nickname) {
                    currentUser.isDM = true;
                    btnBecomeDM.classList.add('hidden');
                    btnDMScreen.classList.remove('hidden');
                }
            }
            playersList.appendChild(li);
        });

        const hasDM = roomState.players.some(p => p.isDM);
        if (hasDM && !currentUser.isDM) btnBecomeDM.classList.add('hidden');
        else if (!hasDM) btnBecomeDM.classList.remove('hidden');

        publicDiceLog.innerHTML = '';
        roomState.logs.forEach(logText => {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.innerHTML = logText;
            publicDiceLog.appendChild(entry);
        });
        publicDiceLog.scrollTop = publicDiceLog.scrollHeight;

        if (roomState.publicImage) {
            mainImage.src = roomState.publicImage;
            mainImage.classList.remove('hidden');
            noImageText.classList.add('hidden');
            document.getElementById('dm-current-public-img').src = roomState.publicImage;
            document.getElementById('dm-current-public-img').classList.remove('hidden');
        } else {
            mainImage.classList.add('hidden');
            noImageText.classList.remove('hidden');
            document.getElementById('dm-current-public-img').classList.add('hidden');
        }
    }

    // ==========================================
    // LÓGICA DE REDE: MQTT (MUITO MAIS COMPATÍVEL)
    // ==========================================
    function connectMQTT(code, isCreating) {
        // Conecta a um broker público que usa WebSockets seguros (wss)
        mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');
        
        topicState = `eros_rpg_app/${code}/state`;
        topicActions = `eros_rpg_app/${code}/actions`;

        mqttClient.on('connect', () => {
            if (isCreating) {
                // Configuração do HOST
                isHost = true;
                roomState.code = code;
                roomState.players = [{ name: currentUser.nickname, isDM: false }];
                roomState.logs = [`<em>Sala criada por ${currentUser.nickname}</em>`];
                
                mqttClient.subscribe(topicActions); // Ouve as ações dos clientes
                publishState(); // Publica o estado inicial retido na rede
                
                btnCreateRoom.textContent = "Criar Sala";
                btnCreateRoom.disabled = false;
                switchScreen('room');
                renderRoom();
            } else {
                // Configuração do CLIENT (Juntar-se)
                isHost = false;
                mqttClient.subscribe(topicState); // Ouve as atualizações de estado do host
                
                // Avisa o host que queremos entrar
                sendAction({ type: 'JOIN', nickname: currentUser.nickname });
            }
        });

        mqttClient.on('message', (topic, message) => {
            const data = JSON.parse(message.toString());
            
            if (isHost && topic === topicActions) {
                handleClientAction(data);
            } 
            else if (!isHost && topic === topicState) {
                // Recebendo atualização de estado do Host
                roomState = data;
                
                // Tratando erros retornados pelo host no estado para este usuário
                if(roomState.errorFor === currentUser.nickname) {
                    loginError.textContent = roomState.errorMessage;
                    loginError.classList.remove('hidden');
                    btnJoinRoom.textContent = "Juntar-se à Sala";
                    btnJoinRoom.disabled = false;
                    mqttClient.end();
                    return;
                }

                if (screens.login.classList.contains('active')) {
                    switchScreen('room');
                }
                renderRoom();
            }
        });

        mqttClient.on('error', (error) => {
            loginError.textContent = "Erro na rede. Verifique a internet e tente novamente.";
            loginError.classList.remove('hidden');
            btnJoinRoom.textContent = "Juntar-se à Sala";
            btnJoinRoom.disabled = false;
            btnCreateRoom.textContent = "Criar Sala";
            btnCreateRoom.disabled = false;
        });
    }

    function publishState() {
        if (!isHost) return;
        // Envia o estado para todos com retain=true (para que quem acabe de se conectar receba o último estado)
        mqttClient.publish(topicState, JSON.stringify(roomState), { retain: true });
        renderRoom(); // Atualiza a tela do host
    }

    function handleClientAction(data) {
        if (!isHost) return;

        if (data.type === 'JOIN') {
            const nameExists = roomState.players.some(p => p.name.toLowerCase() === data.nickname.toLowerCase());
            if (nameExists) {
                // Envia um erro específico no state para o usuário ser expulso
                roomState.errorFor = data.nickname;
                roomState.errorMessage = 'Este apelido já está em uso nesta sala.';
                publishState();
                
                // Limpa o erro logo depois
                setTimeout(() => {
                    roomState.errorFor = null;
                    publishState();
                }, 1000);
                return;
            }
            
            roomState.players.push({ name: data.nickname, isDM: false });
            roomState.logs.push(`<em>${data.nickname} entrou na sala!</em>`);
            publishState();
        }

        if (data.type === 'ROLL_DICE') {
            const result = Math.floor(Math.random() * data.sides) + 1;
            const logMsg = `<strong>${data.nickname}</strong> rolou 1d${data.sides} <br> Resultado: <strong style="font-size: 1.2em; color: var(--accent);">${result}</strong>`;
            roomState.logs.push(logMsg);
            publishState();
        }

        if (data.type === 'BECOME_DM') {
            const hasDM = roomState.players.some(p => p.isDM);
            if (!hasDM) {
                const p = roomState.players.find(p => p.name === data.nickname);
                if (p) p.isDM = true;
                roomState.logs.push(`<em>${data.nickname} assumiu o Escudo do Mestre!</em>`);
                publishState();
            }
        }

        if (data.type === 'UPDATE_IMAGE') {
            const p = roomState.players.find(p => p.name === data.nickname);
            if (p && p.isDM) {
                roomState.publicImage = data.url;
                if(data.url) roomState.logs.push(`<em>O Mestre alterou a imagem do cenário.</em>`);
                publishState();
            }
        }
    }

    function sendAction(actionObj) {
        actionObj.nickname = currentUser.nickname;
        if (isHost) {
            handleClientAction(actionObj);
        } else {
            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(topicActions, JSON.stringify(actionObj));
            }
        }
    }

    // --- Lógica de Interface Básica ---
    function handleLogin(isCreating) {
        const nickname = nicknameInput.value.trim();
        let code = roomCodeInput.value.trim().toUpperCase();

        if (!nickname) {
            loginError.textContent = "Por favor, digite seu apelido.";
            loginError.classList.remove('hidden'); return;
        }

        loginError.classList.add('hidden');
        currentUser.nickname = nickname;

        if (isCreating) {
            btnCreateRoom.textContent = "Criando...";
            btnCreateRoom.disabled = true;
            connectMQTT(generateRoomCode(), true);
        } else {
            if (!code) {
                loginError.textContent = "Para entrar, digite o código da sala.";
                loginError.classList.remove('hidden'); return;
            }
            btnJoinRoom.textContent = "Conectando...";
            btnJoinRoom.disabled = true;
            connectMQTT(code, false);
        }
    }

    btnCreateRoom.addEventListener('click', () => handleLogin(true));
    btnJoinRoom.addEventListener('click', () => handleLogin(false));

    // Desconecta se fechar a aba e limpa a sala
    window.addEventListener('beforeunload', () => {
        if(isHost && mqttClient) {
            // Limpa a sala retida no servidor MQTT para que ninguém consiga entrar nela velha depois
            mqttClient.publish(topicState, '', { retain: true }); 
        }
        if(mqttClient) mqttClient.end();
    });

    // --- Interações da Sala ---
    // Dados Públicos
    document.querySelectorAll('.dice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sides = parseInt(btn.getAttribute('data-sides'));
            sendAction({ type: 'ROLL_DICE', sides: sides });
        });
    });

    // Dados Privados (Apenas no PC de quem clicar, não vai pra rede)
    document.querySelectorAll('.private-dice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sides = parseInt(btn.getAttribute('data-sides'));
            const result = Math.floor(Math.random() * sides) + 1;
            const privateDiceLog = document.getElementById('private-dice-results');
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.innerHTML = `Rolagem Oculta (1d${sides}) <br>Resultado: <strong style="color: var(--danger);">${result}</strong>`;
            privateDiceLog.appendChild(entry);
            privateDiceLog.scrollTop = privateDiceLog.scrollHeight;
        });
    });

    btnBecomeDM.addEventListener('click', () => {
        sendAction({ type: 'BECOME_DM' });
    });

    const btnSetPublicImg = document.getElementById('btn-set-public-img');
    const publicImgUrlInput = document.getElementById('public-img-url');
    
    btnSetPublicImg.addEventListener('click', () => {
        const url = publicImgUrlInput.value.trim();
        sendAction({ type: 'UPDATE_IMAGE', url: url });
        publicImgUrlInput.value = '';
    });

    // Modais e Abas visuais
    btnDMScreen.addEventListener('click', () => dmModal.classList.remove('hidden'));
    btnCloseDM.addEventListener('click', () => dmModal.classList.add('hidden'));
    window.addEventListener('click', (e) => { if (e.target === dmModal) dmModal.classList.add('hidden'); });

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.getAttribute('data-target')).classList.add('active');
        });
    });

    // Fichas Privadas do Mestre
    const btnAddMonster = document.getElementById('btn-add-monster');
    const btnAddNpc = document.getElementById('btn-add-npc');
    const monsterTemplate = document.getElementById('monster-template');
    const npcTemplate = document.getElementById('npc-template');
    
    function createSheet(template, container) {
        const clone = template.content.cloneNode(true);
        const card = clone.querySelector('.sheet-card');
        clone.querySelector('.btn-remove-sheet').addEventListener('click', () => card.remove());
        container.appendChild(clone);
    }
    btnAddMonster.addEventListener('click', () => createSheet(monsterTemplate, document.getElementById('monsters-list')));
    btnAddNpc.addEventListener('click', () => createSheet(npcTemplate, document.getElementById('npcs-list')));

    // Imagens Privadas
    const privateImgUrlInput = document.getElementById('private-img-url');
    document.getElementById('btn-add-private-img').addEventListener('click', () => {
        const url = privateImgUrlInput.value.trim();
        if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'private-img-item';
            img.onerror = () => { alert("Erro ao carregar imagem privada."); img.remove(); };
            document.getElementById('private-images-list').appendChild(img);
            privateImgUrlInput.value = '';
        }
    });
});
