<#macro passwordToggleButton toggleId inputId label="Show password" hideLabel="Hide password">
    <button type="button" id="${toggleId}" class="password-toggle-btn"
            aria-label="${label}"
            data-input="${inputId}"
            data-label-show="${label}"
            data-label-hide="${hideLabel}"
            data-icon-password="${url.resourcesPath}/img/eye.svg"
            data-icon-text="${url.resourcesPath}/img/eye-slash.svg">
        <img class="password-toggle-icon" src="${url.resourcesPath}/img/eye.svg" width="20" height="20" alt="" aria-hidden="true" />
    </button>
</#macro>

<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false showAnotherWayIfPresent=true>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}"<#if realm.internationalizationEnabled> lang="${locale.currentLanguageTag}"</#if>>

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>ICPH Forms</title>
    <link rel="icon" type="image/png" href="${url.resourcesPath}/img/favicon.png" />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
</head>

<body class="${properties.kcBodyClass!}">
<#-- App base URL: the client the user came from, then the theme default -->
<#assign navBasePath = (properties.navBasePath!'')?trim?remove_ending('/')>
<#if client?? && client.rootUrl?has_content>
    <#assign navBasePath = client.rootUrl?trim?remove_ending('/')>
</#if>
<nav class="icph-navbar">
    <div class="header-inner">
        <#-- Brand logos: ICPH | CDPG -->
        <div class="header-logos">
            <a href="${navBasePath}/" class="logo-container">
                <img src="${url.resourcesPath}/img/icph-logo.png" alt="ICPH" class="logo-image logo-image-icph" />
            </a>
            <span class="logo-divider" aria-hidden="true"></span>
            <span class="logo-partner">
                <img src="${url.resourcesPath}/img/cdpg-logo.png" alt="Centre for Data for Public Good" class="logo-image logo-image-cdpg" />
            </span>
        </div>
        <a class="header-back-link" href="${navBasePath}/">Back to ICPH Forms</a>
    </div>
</nav>

<div class="${properties.kcLoginClass!} icph-login-page">
    <div class="icph-login-center">

        <div id="custom-card-pf" class="${properties.kcFormCardClass!} icph-auth-card">
            <header class="${properties.kcFormHeaderClass!}">
                <#if realm.internationalizationEnabled && locale.supported?size gt 1>
                    <div class="${properties.kcLocaleMainClass!}" id="kc-locale">
                        <div id="kc-locale-wrapper" class="${properties.kcLocaleWrapperClass!}">
                            <div id="kc-locale-dropdown" class="${properties.kcLocaleDropDownClass!}">
                                <a href="#" id="kc-current-locale-link">${locale.current}</a>
                                <ul class="${properties.kcLocaleListClass!}">
                                    <#list locale.supported as l>
                                        <li class="${properties.kcLocaleListItemClass!}">
                                            <a class="${properties.kcLocaleItemClass!}" href="${l.url}">${l.label}</a>
                                        </li>
                                    </#list>
                                </ul>
                            </div>
                        </div>
                    </div>
                </#if>

                <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
                    <#if displayRequiredFields>
                        <div class="subtitle"><span class="required">*</span> ${msg("requiredFields")}</div>
                    </#if>
                    <h1 id="kc-page-title"><#nested "header"></h1>
                <#else>
                    <#if displayRequiredFields>
                        <div class="subtitle"><span class="required">*</span> ${msg("requiredFields")}</div>
                    </#if>
                    <#nested "show-username">
                    <div id="kc-username" class="${properties.kcFormGroupClass!}">
                        <label id="kc-attempted-username">${auth.attemptedUsername}</label>
                        <a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("restartLoginTooltip")}</a>
                    </div>
                </#if>
            </header>
            <div id="kc-content">
                <div id="custom-kc-content-wrapper">

                <#-- App-initiated actions should not see warning messages about the need to complete the action -->
                <#-- during login.                                                                               -->
                <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                    <div class="icph-alert icph-alert-${message.type}" role="alert">
                        <span>${kcSanitize(message.summary)?no_esc}</span>
                    </div>
                </#if>

                <#nested "form">

                <#if auth?has_content && auth.showTryAnotherWayLink() && showAnotherWayIfPresent>
                    <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                        <div class="${properties.kcFormGroupClass!}">
                            <input type="hidden" name="tryAnotherWay" value="on"/>
                            <a href="#" id="try-another-way"
                               onclick="document.forms['kc-select-try-another-way-form'].submit();return false;">${msg("doTryAnotherWay")}</a>
                        </div>
                    </form>
                </#if>

                <#nested "socialProviders">

                <#if displayInfo>
                    <div id="kc-info" class="${properties.kcSignUpClass!}">
                        <div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}">
                            <#nested "info">
                        </div>
                    </div>
                </#if>
                </div>
            </div>

        </div>
    </div>
</div>
<script>
(function () {
    // The logo and back link return to wherever the login was started from.
    try {
        var redirect = new URLSearchParams(window.location.search).get("redirect_uri");
        var origin = redirect ? new URL(redirect).origin : sessionStorage.getItem("icph-app-origin");
        if (origin && /^https?:/.test(origin)) {
            sessionStorage.setItem("icph-app-origin", origin);
            document.querySelectorAll(".logo-container, .header-back-link").forEach(function (el) {
                el.setAttribute("href", origin + "/");
            });
        }
    } catch (e) { /* keep the default links */ }

    document.querySelectorAll(".password-toggle-btn").forEach(function (button) {
        button.addEventListener("click", function () {
            var input = document.getElementById(button.getAttribute("data-input"));
            if (!input) return;
            var masked = input.type === "password";
            input.type = masked ? "text" : "password";
            button.querySelector(".password-toggle-icon").src = button.getAttribute(masked ? "data-icon-text" : "data-icon-password");
            button.setAttribute("aria-label", button.getAttribute(masked ? "data-label-hide" : "data-label-show"));
        });
    });
})();
</script>
</body>
</html>
</#macro>
