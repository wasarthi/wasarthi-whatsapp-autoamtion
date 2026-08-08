document.addEventListener('DOMContentLoaded', () => {
    if (typeof hydrateIcons === 'function') hydrateIcons();

    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    initNavScroll();
    initHeroCanvas();
    initPhoneTilt();
    initFloatParallax();
    initFeatureTilt();
    initReveal();
    initChatLoop();
});

// ─── Nav background on scroll ──────────────────────────────
function initNavScroll() {
    const nav = document.getElementById('landingNav');
    if (!nav) return;
    const onScroll = () => {
        if (window.scrollY > 40) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
}

// ─── Animated green-gradient blob canvas (mouse-reactive) ──
function initHeroCanvas() {
    const canvas = document.getElementById('heroCanvas');
    const hero = document.getElementById('hero');
    if (!canvas || !hero) return;
    const ctx = canvas.getContext('2d');
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0;
    function resize() {
        w = hero.offsetWidth;
        h = hero.offsetHeight;
        canvas.width = w * DPR;
        canvas.height = h * DPR;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const blobs = [
        { x: .18, y: .28, r: .34, color: 'rgba(46,181,110,0.30)', dx: 0.00012, dy: 0.00009, phase: 0 },
        { x: .78, y: .18, r: .28, color: 'rgba(111,208,154,0.22)', dx: -0.00010, dy: 0.00014, phase: 2 },
        { x: .62, y: .74, r: .38, color: 'rgba(20,120,76,0.28)', dx: 0.00008, dy: -0.00011, phase: 4 },
        { x: .12, y: .82, r: .24, color: 'rgba(217,180,91,0.14)', dx: -0.00013, dy: -0.00008, phase: 1 }
    ];

    let mouseX = 0.5, mouseY = 0.5;
    let targetMouseX = 0.5, targetMouseY = 0.5;
    hero.addEventListener('mousemove', (e) => {
        const rect = hero.getBoundingClientRect();
        targetMouseX = (e.clientX - rect.left) / rect.width;
        targetMouseY = (e.clientY - rect.top) / rect.height;
    });

    let raf = null;
    function frame(t) {
        mouseX += (targetMouseX - mouseX) * 0.03;
        mouseY += (targetMouseY - mouseY) * 0.03;

        ctx.clearRect(0, 0, w, h);
        // base dark wash so blobs feel embedded, not pasted
        for (const b of blobs) {
            const bx = (b.x + Math.sin(t * b.dx + b.phase) * 0.05 + (mouseX - 0.5) * 0.04) * w;
            const by = (b.y + Math.cos(t * b.dy + b.phase) * 0.05 + (mouseY - 0.5) * 0.04) * h;
            const r = b.r * Math.max(w, h);
            const grad = ctx.createRadialGradient(bx, by, 0, bx, by, r);
            grad.addColorStop(0, b.color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fill();
        }
        raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    // Pause the animation when the hero scrolls out of view (saves battery/CPU)
    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    if (!raf) raf = requestAnimationFrame(frame);
                } else if (raf) {
                    cancelAnimationFrame(raf);
                    raf = null;
                }
            });
        }, { threshold: 0.01 });
        io.observe(hero);
    }
}

// ─── 3D tilt on the phone mockup, following the pointer ────
function initPhoneTilt() {
    const scene = document.getElementById('heroScene');
    const phone = document.getElementById('phoneMock');
    if (!scene || !phone) return;

    scene.addEventListener('mousemove', (e) => {
        const rect = scene.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        const rotY = -14 + px * 22;
        const rotX = 6 - py * 18;
        phone.style.transform = `rotateY(${rotY}deg) rotateX(${rotX}deg)`;
    });
    scene.addEventListener('mouseleave', () => {
        phone.style.transform = 'rotateY(-14deg) rotateX(6deg)';
    });
}

// ─── Floating cards drift slightly with the pointer (parallax depth) ──
function initFloatParallax() {
    const scene = document.getElementById('heroScene');
    if (!scene) return;
    const cards = [
        { el: document.getElementById('fc1'), depth: 18 },
        { el: document.getElementById('fc2'), depth: 26 },
        { el: document.getElementById('fc3'), depth: 12 }
    ].filter(c => c.el);

    scene.addEventListener('mousemove', (e) => {
        const rect = scene.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        cards.forEach(c => {
            c.el.style.marginLeft = (px * c.depth) + 'px';
            c.el.style.marginTop = (py * c.depth * 0.6) + 'px';
        });
    });
}

// ─── Subtle 3D tilt on feature cards, following the cursor ─
function initFeatureTilt() {
    const cards = document.querySelectorAll('.feature-card');
    cards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const px = (e.clientX - rect.left) / rect.width - 0.5;
            const py = (e.clientY - rect.top) / rect.height - 0.5;
            card.style.transform = `rotateY(${px * 10}deg) rotateX(${-py * 10}deg) translateY(-4px)`;
        });
        card.addEventListener('mouseleave', () => {
            card.style.transform = 'rotateY(0deg) rotateX(0deg) translateY(0)';
        });
    });
}

// ─── Scroll-reveal via IntersectionObserver ─────────────────
function initReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) || els.length === 0) {
        els.forEach(el => el.classList.add('visible'));
        return;
    }
    const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                io.unobserve(entry.target);
            }
        });
    }, { threshold: 0.15 });
    els.forEach(el => io.observe(el));
}

// ─── Looping demo conversation inside the phone mockup ─────
function initChatLoop() {
    const chat = document.getElementById('phoneChat');
    if (!chat) return;

    const script = [
        { side: 'in', text: 'Hi! Do you have the Website Package in stock right now?' },
        { side: 'out', text: 'Yes! ₹15,000, delivered in under 3 weeks. Want me to send the portfolio? 😊' },
        { side: 'in', text: 'Yes please, and is there any discount?' },
        { side: 'out', text: '10% off this month — I\'ll mark you as a hot lead for the team!' }
    ];

    let i = 0;
    let running = false;

    function addBubble(side, text) {
        const b = document.createElement('div');
        b.className = 'bubble ' + side;
        b.textContent = text;
        chat.appendChild(b);
        chat.scrollTop = chat.scrollHeight;
    }

    function addTyping() {
        const b = document.createElement('div');
        b.className = 'bubble typing';
        b.id = 'typingBubble';
        b.innerHTML = '<span></span><span></span><span></span>';
        chat.appendChild(b);
        chat.scrollTop = chat.scrollHeight;
    }

    function removeTyping() {
        const t = document.getElementById('typingBubble');
        if (t) t.remove();
    }

    async function step() {
        if (running) return;
        running = true;
        chat.innerHTML = '';
        for (const msg of script) {
            await new Promise(r => setTimeout(r, msg.side === 'out' ? 1100 : 900));
            if (msg.side === 'out') {
                addTyping();
                await new Promise(r => setTimeout(r, 1300));
                removeTyping();
            }
            addBubble(msg.side, msg.text);
        }
        running = false;
        setTimeout(step, 3200);
    }
    step();
}
