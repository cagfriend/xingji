const $=selector=>document.querySelector(selector);
const form=$('#login-form');
const password=$('#login-password');
const submit=$('#login-submit');
const status=$('#login-status');
const logoutPanel=$('#logout-panel');
const logoutStatus=$('#logout-status');
const logoutRetry=$('#logout-retry');

async function logout(){
  logoutStatus.textContent='正在退出登录…';
  logoutRetry.disabled=true;
  try{
    const response=await fetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Trip-Local':'1'},body:'{}'});
    if(!response.ok)throw new Error('暂时无法退出，请稍后重试。');
    location.replace('/login');
  }catch(error){logoutStatus.textContent=error.message;logoutRetry.disabled=false;}
}

if(new URLSearchParams(location.search).get('logout')==='1'){
  form.hidden=true;
  logoutPanel.hidden=false;
  logoutRetry.addEventListener('click',logout);
  logout();
}else{
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!password.value){password.focus();status.textContent='请输入访问密码。';return;}
    status.textContent='正在验证…';submit.disabled=true;
    try{
      const response=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Trip-Local':'1'},body:JSON.stringify({password:password.value})});
      if(response.ok){location.replace('/');return;}
      if(response.status===401)status.textContent='密码不正确，请重新输入。';
      else if(response.status===429)status.textContent='尝试次数过多，请稍后再试。';
      else if(response.status===503)status.textContent='登录服务暂时不可用，请稍后重试。';
      else status.textContent='暂时无法登录，请检查网络后重试。';
      password.value='';password.focus();
    }catch{status.textContent='无法连接登录服务，请检查网络后重试。';password.value='';password.focus();}
    finally{submit.disabled=false;}
  });
}
