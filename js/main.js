/**
 * BirdWatchAI Website JavaScript
 */

document.addEventListener('DOMContentLoaded', function() {
    // Mobile navigation toggle
    const navToggle = document.querySelector('.nav-mobile-toggle');
    const navLinks = document.querySelector('.nav-links');
    
    if (navToggle && navLinks) {
        navToggle.addEventListener('click', function() {
            navLinks.classList.toggle('active');
            // Animate hamburger to X
            this.classList.toggle('active');
        });
        
        // Close mobile nav when clicking a link
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('active');
                navToggle.classList.remove('active');
            });
        });
    }
    
    // Smooth scroll for anchor links (fallback for browsers without CSS scroll-behavior)
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                e.preventDefault();
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // Navigation background on scroll
    const nav = document.querySelector('.nav');
    let lastScroll = 0;
    
    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;
        
        if (currentScroll > 50) {
            nav.style.boxShadow = '0 2px 20px rgba(45, 90, 61, 0.1)';
        } else {
            nav.style.boxShadow = 'none';
        }
        
        lastScroll = currentScroll;
    });
    
    // Download button - GitHub Releases
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', function(e) {
            const downloadUrl = 'https://github.com/JoeBarraco/BirdWatchAI-Releases/releases/download/v1.4.0.0/BirdWatchAI_Setup_1.4.0.0.exe';
            
            // Track download (if you add analytics later)
            console.log('Download initiated');
            
            // Start download
            window.location.href = downloadUrl;
        });
    }
    
    // Buy button - Gumroad product link
    const buyBtn = document.getElementById('buy-btn');
    if (buyBtn) {
        buyBtn.addEventListener('click', function(e) {
            e.preventDefault();
            
            const gumroadUrl = 'https://birdbrainllc.gumroad.com/l/dajhd';
            
            // Open in new tab for payment
            window.open(gumroadUrl, '_blank');
        });
    }
    
    // Intersection Observer for scroll animations
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);
    
    // Observe all feature cards and other animated elements
    document.querySelectorAll('.feature-card, .step, .pricing-card, .faq-item, .requirement-card, .gallery-item').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(el);
    });
    
    // Add stagger delay to grid items
    document.querySelectorAll('.features-grid .feature-card').forEach((card, index) => {
        card.style.transitionDelay = `${index * 0.1}s`;
    });
    
    document.querySelectorAll('.faq-grid .faq-item').forEach((item, index) => {
        item.style.transitionDelay = `${index * 0.1}s`;
    });
});

// Utility function for future use - format currency
function formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0
    }).format(amount);
}

// Console Easter egg for developers
console.log('%c🐦 BirdWatchAI', 'font-size: 24px; font-weight: bold; color: #2d5a3d;');
console.log('%cAutomatic bird detection for your backyard feeders.', 'color: #7a756d;');
console.log('%cInterested in how this works? Check out the GitHub: https://github.com/JoeBarraco/BirdWatchAI', 'color: #3d7a52;');
