// 应用前端逻辑

document.addEventListener('DOMContentLoaded', () => {
    console.log('应用已加载');
    
    // 初始化界面
    initApp();
});

function initApp() {
    // 显示欢迎信息
    const message = '欢迎使用网页应用 - ' + new Date().toLocaleString('zh-CN');
    console.log(message);
    
    // 可以在这里添加更多初始化逻辑
}
